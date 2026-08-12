// Linux directory watching for `host.h`, over inotify.
//
// Written from scratch — the inotify calls are the documented API and nothing here is adapted from
// another project, so there is no licence to inherit.
//
// ─── the shape, and why it is more work than Windows ────────────────────────────────────────────
//
// ReadDirectoryChangesW watches a tree with one handle. inotify does NOT: it watches ONE directory
// per descriptor, so "recursive" means walking the tree at open and adding a watch per directory,
// then adding another whenever a directory is created. Every recursive inotify watcher does this;
// there is no kernel shortcut.
//
// Two consequences a caller feels, both handled below rather than hidden:
//
//   · **A directory created and populated fast can beat us to it.** Between IN_CREATE arriving and
//     inotify_add_watch returning, files may already exist inside — they generate no event because
//     nothing was watching yet. So a newly watched directory is SCANNED once and its contents are
//     reported as creates. Without that, `git checkout` of a new folder is silently invisible.
//   · **Watches are a finite kernel resource** (fs.inotify.max_user_watches, often 8192 on a stock
//     box and easily exceeded by node_modules). Running out is reported as OVERFLOW and the walk
//     continues, because half a watch tree that says so beats no watch tree at all.
//
// ─── teardown ──────────────────────────────────────────────────────────────────────────────────
//
// Same fixed order as the Windows backend, for the same reason: signal, wake, JOIN, then close the
// descriptors, then free. The join is what makes every following line safe.

#ifndef _WIN32

#include "host.h"

#include <dirent.h>
#include <errno.h>
#include <poll.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

constexpr size_t kReadBytes = 64 * 1024;
constexpr size_t kMaxQueued = 8192;

constexpr uint32_t kMask = IN_CREATE | IN_DELETE | IN_MODIFY | IN_ATTRIB | IN_MOVED_FROM | IN_MOVED_TO |
                           IN_DELETE_SELF | IN_MOVE_SELF;

void write_error(char *err, int32_t errlen, const char *what, int code) {
  if (err == nullptr || errlen <= 0) return;
  snprintf(err, static_cast<size_t>(errlen), "%s (errno %d: %s)", what, code, strerror(code));
}

struct Record {
  host_watch_event type;
  std::string path;
};

}  // namespace

struct host_watch {
  int fd = -1;       // inotify
  int stop_fd = -1;  // eventfd, so the worker wakes deterministically instead of on a timeout
  std::atomic<bool> stopping{false};
  std::thread worker;
  std::mutex lock;
  std::deque<Record> queue;
  std::string root;
  std::unordered_set<std::string> ignore;
  // Watch descriptor -> absolute directory path. Touched only by the worker after the thread starts,
  // and by open() before it does — so it needs no lock of its own.
  std::unordered_map<int, std::string> directories;

  void push(host_watch_event type, std::string path) {
    std::lock_guard<std::mutex> guard(lock);
    if (queue.size() >= kMaxQueued) {
      queue.pop_front();
      if (queue.empty() || queue.front().type != HOST_WATCH_OVERFLOW)
        queue.push_front(Record{HOST_WATCH_OVERFLOW, std::string()});
    }
    queue.push_back(Record{type, std::move(path)});
  }
};

namespace {


/**
 * Should this absolute path be dropped?
 *
 * ⚠️ Only segments BELOW `root` are considered. Watching `/home/me/build/project` must not discard
 * the whole tree because an ancestor is named `build` — the caller asked to watch that directory, and
 * an ignore rule may not overrule the subject of the watch itself.
 */
bool ignored(const std::unordered_set<std::string> &names, const std::string &root, const std::string &full) {
  if (names.empty()) return false;
  if (full.size() <= root.size() + 1) return false;
  size_t start = root.size() + 1;  // skip the root and its separator
  while (start <= full.size()) {
    const size_t slash = full.find('/', start);
    const size_t end = slash == std::string::npos ? full.size() : slash;
    if (names.count(full.substr(start, end - start)) != 0) return true;
    if (slash == std::string::npos) break;
    start = slash + 1;
  }
  return false;
}


bool is_directory(const std::string &path) {
  struct stat info;
  return ::stat(path.c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}

/**
 * Add a watch for `dir` and every directory beneath it.
 *
 * `report_existing` is what closes the race described at the top: for a directory discovered AFTER
 * the initial walk, its contents already exist and produced no events, so they are announced here.
 *
 * ⚠️ **This DUPLICATES events, deliberately, and the trade is the point.** A file written into the
 * new directory just after `inotify_add_watch` returns is both delivered by inotify and seen by this
 * scan — measured on the Spark: one `inside.txt` arrived as two creates. Removing the duplicate
 * needs per-path state with a lifetime nobody can bound, and the two failures are not symmetric: a
 * DUPLICATE create costs a consumer one redundant read, while a MISSED create is a file the product
 * never learns about. So duplicates are allowed and consumers must be idempotent — which the caller
 * already is, since it publishes add/change events that describe a path rather than a delta.
 */
void add_tree(host_watch *w, const std::string &dir, bool report_existing) {
  // ⚠️ Ignored trees are never WATCHED, not merely filtered afterwards — and on Linux that is the
  // larger half of the win. inotify spends one kernel watch descriptor per directory, and
  // `node_modules` is precisely what exhausts `fs.inotify.max_user_watches`; declining to descend
  // turns the limit from a routine failure into a rare one.
  if (ignored(w->ignore, w->root, dir)) return;
  const int wd = ::inotify_add_watch(w->fd, dir.c_str(), kMask);
  if (wd < 0) {
    // ENOSPC is the watch limit. Say so once through OVERFLOW and keep walking: a partial tree that
    // admits it is partial is more useful than abandoning the whole watch.
    if (errno == ENOSPC) w->push(HOST_WATCH_OVERFLOW, std::string());
    return;
  }
  w->directories[wd] = dir;

  DIR *handle = ::opendir(dir.c_str());
  if (handle == nullptr) return;
  while (dirent *entry = ::readdir(handle)) {
    const std::string name = entry->d_name;
    if (name == "." || name == "..") continue;
    const std::string child = dir + "/" + name;
    const bool directory = entry->d_type == DT_DIR || (entry->d_type == DT_UNKNOWN && is_directory(child));
    if (report_existing && !ignored(w->ignore, w->root, child)) w->push(HOST_WATCH_CREATE, child);
    if (directory) add_tree(w, child, report_existing);
  }
  ::closedir(handle);
}

void run(host_watch *w) {
  std::vector<char> buffer(kReadBytes);
  while (!w->stopping.load(std::memory_order_acquire)) {
    pollfd fds[2] = {{w->fd, POLLIN, 0}, {w->stop_fd, POLLIN, 0}};
    const int ready = ::poll(fds, 2, -1);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (fds[1].revents & POLLIN) break;  // stop
    if (!(fds[0].revents & POLLIN)) continue;

    const ssize_t got = ::read(w->fd, buffer.data(), buffer.size());
    if (got <= 0) {
      if (got < 0 && (errno == EAGAIN || errno == EINTR)) continue;
      break;
    }

    size_t offset = 0;
    while (offset + sizeof(inotify_event) <= static_cast<size_t>(got)) {
      const auto *event = reinterpret_cast<const inotify_event *>(buffer.data() + offset);
      offset += sizeof(inotify_event) + event->len;

      if (event->mask & IN_Q_OVERFLOW) {
        w->push(HOST_WATCH_OVERFLOW, std::string());
        continue;
      }
      const auto found = w->directories.find(event->wd);
      if (found == w->directories.end()) continue;
      const std::string name = event->len > 0 ? std::string(event->name) : std::string();
      const std::string full = name.empty() ? found->second : found->second + "/" + name;

      if (event->mask & (IN_DELETE_SELF | IN_MOVE_SELF)) {
        w->directories.erase(found);
        continue;
      }
      if (ignored(w->ignore, w->root, full)) continue;
      if (event->mask & (IN_CREATE | IN_MOVED_TO)) {
        w->push(HOST_WATCH_CREATE, full);
        // A new directory needs its own watch, and its contents may already be there.
        if ((event->mask & IN_ISDIR) != 0) add_tree(w, full, true);
        continue;
      }
      if (event->mask & (IN_DELETE | IN_MOVED_FROM)) {
        w->push(HOST_WATCH_DELETE, full);
        continue;
      }
      if (event->mask & (IN_MODIFY | IN_ATTRIB)) w->push(HOST_WATCH_UPDATE, full);
    }
  }
}

}  // namespace

extern "C" {

int32_t host_abi_version(void) { return HOST_ABI_VERSION; }

host_watch *host_watch_open(const char *path, const char *const *ignore_dirs, int32_t ignore_count,
                            char *err, int32_t errlen) {
  if (path == nullptr || *path == '\0') {
    write_error(err, errlen, "no path given", EINVAL);
    return nullptr;
  }
  if (!is_directory(path)) {
    write_error(err, errlen, "not a directory", ENOTDIR);
    return nullptr;
  }

  auto *w = new host_watch();
  w->fd = ::inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
  if (w->fd < 0) {
    write_error(err, errlen, "could not create the inotify handle", errno);
    delete w;
    return nullptr;
  }
  w->stop_fd = ::eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
  if (w->stop_fd < 0) {
    write_error(err, errlen, "could not create the stop handle", errno);
    ::close(w->fd);
    delete w;
    return nullptr;
  }

  w->root.assign(path);
  while (w->root.size() > 1 && w->root.back() == '/') w->root.pop_back();
  for (int32_t i = 0; i < ignore_count && ignore_dirs != nullptr; ++i)
    if (ignore_dirs[i] != nullptr) w->ignore.insert(ignore_dirs[i]);

  // The INITIAL walk does not report what it finds: the caller asked to watch a tree, not to be told
  // it already exists. Only directories discovered later announce their contents.
  add_tree(w, w->root, false);
  if (w->directories.empty()) {
    write_error(err, errlen, "could not watch the directory", ENOSPC);
    ::close(w->stop_fd);
    ::close(w->fd);
    delete w;
    return nullptr;
  }

  w->worker = std::thread(run, w);
  return w;
}

int32_t host_watch_poll(host_watch *w, char *buf, int32_t buflen, char *err, int32_t errlen) {
  if (w == nullptr || buf == nullptr || buflen <= 0) {
    write_error(err, errlen, "poll called with no watch or no buffer", EINVAL);
    return -1;
  }
  std::lock_guard<std::mutex> guard(w->lock);
  int32_t written = 0;
  while (!w->queue.empty()) {
    const Record &record = w->queue.front();
    const int32_t needed = static_cast<int32_t>(1 + record.path.size() + 1);
    if (written + needed > buflen) break;  // never a partial record — see host.h
    buf[written++] = static_cast<char>(record.type);
    if (!record.path.empty()) {
      memcpy(buf + written, record.path.data(), record.path.size());
      written += static_cast<int32_t>(record.path.size());
    }
    buf[written++] = '\0';
    w->queue.pop_front();
  }
  return written;
}

void host_watch_close(host_watch *w) {
  if (w == nullptr) return;
  // 1 — no further iterations.
  w->stopping.store(true, std::memory_order_release);
  // 2 — wake the poll. eventfd rather than a signal: no EINTR storm, no handler to install.
  if (w->stop_fd >= 0) {
    const uint64_t one = 1;
    const ssize_t ignored = ::write(w->stop_fd, &one, sizeof(one));
    (void)ignored;
  }
  // 3 — JOIN. Nothing below may run while the worker can still touch `w`.
  if (w->worker.joinable()) w->worker.join();
  // 4 — descriptors are unreferenced now, and not before.
  if (w->fd >= 0) ::close(w->fd);
  if (w->stop_fd >= 0) ::close(w->stop_fd);
  // 5 — and the struct last.
  delete w;
}

}  // extern "C"

#endif  // !_WIN32
