// Windows directory watching for `host.h`, over ReadDirectoryChangesW.
//
// Written from scratch rather than adapted, so there is no licence question to answer: the Win32
// calls below are the documented API and nothing here is copied from another watcher.
//
// ─── the shape ─────────────────────────────────────────────────────────────────────────────────
//
// One worker thread per watch. It issues an overlapped ReadDirectoryChangesW, waits on TWO handles
// (the completion event and a stop event), decodes whatever arrived into a queue, and reissues.
// The caller drains the queue with host_watch_poll. No callback ever crosses into the JS runtime —
// see host.h for why that is a rule and not a preference.
//
// ─── the teardown, which is the reason this file exists ────────────────────────────────────────
//
// 🔴 The crash that started this module was a fault at 0xFFFFFFFFFFFFFFFF inside another project's
// watcher during process shutdown. That address is -1: INVALID_HANDLE_VALUE, or freed memory
// poisoned with 0xFF. Both readings say the same thing — something touched a watch that had already
// been taken apart.
//
// So the order in `host_watch_close` is fixed and commented, and it is the ONLY safe one:
//
//   1. set `stopping` and signal the stop event      — the worker will not start another read
//   2. CancelIoEx                                    — release a read already in flight
//   3. JOIN the worker                               — after this line no other thread touches `w`
//   4. CloseHandle(directory), CloseHandle(events)   — safe now, and only now
//   5. delete w                                      — ditto
//
// Steps 3 and 4 in the other order is the bug: the worker wakes on a cancelled read, dereferences a
// handle the closer just invalidated, and faults exactly where ours did.

#ifdef _WIN32

#include "host.h"

#include <windows.h>

#include <atomic>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

namespace {

/** Big enough that ordinary editing never overflows; small enough to keep per-watch cost sane. */
constexpr DWORD kBufferBytes = 64 * 1024;

constexpr DWORD kFilter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
                          FILE_NOTIFY_CHANGE_ATTRIBUTES | FILE_NOTIFY_CHANGE_SIZE |
                          FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION;

void write_error(char *err, int32_t errlen, const char *what, DWORD code) {
  if (err == nullptr || errlen <= 0) return;
  // No allocation, no formatting library: this runs on failure paths where the less we do the better.
  _snprintf_s(err, static_cast<size_t>(errlen), _TRUNCATE, "%s (win32 error %lu)", what, code);
}

std::string to_utf8(const wchar_t *text, size_t length) {
  if (length == 0) return std::string();
  const int needed =
      ::WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string out(static_cast<size_t>(needed), '\0');
  ::WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(length), out.data(), needed, nullptr, nullptr);
  return out;
}

/** One queued event: a type plus an absolute UTF-8 path (empty for OVERFLOW). */
struct Record {
  host_watch_event type;
  std::string path;
};

}  // namespace

struct host_watch {
  HANDLE directory = INVALID_HANDLE_VALUE;
  HANDLE completion = nullptr;  // the OVERLAPPED event ReadDirectoryChangesW signals
  HANDLE stop = nullptr;        // set by the closer so the worker wakes deterministically
  std::atomic<bool> stopping{false};
  std::thread worker;
  std::mutex lock;
  std::deque<Record> queue;
  std::string root;  // absolute, UTF-8, without a trailing separator
  std::unordered_set<std::string> ignore;

  void push(host_watch_event type, std::string path) {
    std::lock_guard<std::mutex> guard(lock);
    // ⚠️ Bounded, and it drops the OLDEST rather than refusing new events. An unbounded queue turns
    // "the consumer is slow" into "the process runs out of memory", and a watcher must not be able to
    // kill the thing it is watching for. Losing the tail is also strictly better than losing the
    // head: the newest events are the ones a caller still needs.
    constexpr size_t kMaxQueued = 8192;
    if (queue.size() >= kMaxQueued) {
      queue.pop_front();
      // Say so, once, rather than silently dropping — a caller that sees OVERFLOW rescans.
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
    const size_t slash = full.find('\\', start);
    const size_t end = slash == std::string::npos ? full.size() : slash;
    if (names.count(full.substr(start, end - start)) != 0) return true;
    if (slash == std::string::npos) break;
    start = slash + 1;
  }
  return false;
}

}  // namespace

namespace {

void run(host_watch *w) {
  std::vector<char> buffer(kBufferBytes);
  OVERLAPPED overlapped{};
  overlapped.hEvent = w->completion;

  while (!w->stopping.load(std::memory_order_acquire)) {
    DWORD returned = 0;
    const BOOL started = ::ReadDirectoryChangesW(w->directory, buffer.data(), kBufferBytes,
                                                 TRUE /* recursive */, kFilter, &returned, &overlapped, nullptr);
    if (!started) {
      // The directory went away (deleted, unmounted, drive ejected). That is a normal end of watch,
      // not a fault: stop cleanly and let the caller notice through the empty queue.
      break;
    }

    HANDLE waits[2] = {w->completion, w->stop};
    const DWORD signalled = ::WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (signalled != WAIT_OBJECT_0) break;  // stop event, or a wait failure — either way, done

    DWORD bytes = 0;
    if (!::GetOverlappedResult(w->directory, &overlapped, &bytes, FALSE)) break;

    // 🔴 Zero bytes with a successful result IS the overflow signal: more changes happened than the
    // buffer could hold and Windows discarded them. Reporting nothing here is how a watcher silently
    // goes stale after a branch switch.
    if (bytes == 0) {
      w->push(HOST_WATCH_OVERFLOW, std::string());
      continue;
    }

    size_t offset = 0;
    while (offset + sizeof(FILE_NOTIFY_INFORMATION) <= bytes) {
      const auto *info = reinterpret_cast<const FILE_NOTIFY_INFORMATION *>(buffer.data() + offset);
      const size_t name_chars = info->FileNameLength / sizeof(wchar_t);
      std::string relative = to_utf8(info->FileName, name_chars);
      for (char &c : relative)
        if (c == '/') c = '\\';

      host_watch_event type = HOST_WATCH_UPDATE;
      switch (info->Action) {
        case FILE_ACTION_ADDED:
        case FILE_ACTION_RENAMED_NEW_NAME:
          type = HOST_WATCH_CREATE;
          break;
        case FILE_ACTION_REMOVED:
        case FILE_ACTION_RENAMED_OLD_NAME:
          type = HOST_WATCH_DELETE;
          break;
        default:
          type = HOST_WATCH_UPDATE;
          break;
      }
      // Absolute paths, because a caller that has to rejoin them re-implements this loop badly.
      const std::string full = relative.empty() ? w->root : w->root + "\\" + relative;
      // Dropped BEFORE it is queued: the point of filtering here is that the noise never wakes the
      // runtime, which a filter on the JS side cannot give.
      if (!ignored(w->ignore, w->root, full)) w->push(type, full);

      if (info->NextEntryOffset == 0) break;
      offset += info->NextEntryOffset;
    }
  }
}

}  // namespace

extern "C" {

int32_t host_abi_version(void) { return HOST_ABI_VERSION; }

host_watch *host_watch_open(const char *path, const char *const *ignore_dirs, int32_t ignore_count,
                            char *err, int32_t errlen) {
  if (path == nullptr || *path == '\0') {
    write_error(err, errlen, "no path given", 0);
    return nullptr;
  }

  const int wide_len = ::MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
  if (wide_len <= 0) {
    write_error(err, errlen, "path is not valid UTF-8", ::GetLastError());
    return nullptr;
  }
  std::wstring wide(static_cast<size_t>(wide_len), L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, path, -1, wide.data(), wide_len);
  if (!wide.empty() && wide.back() == L'\0') wide.pop_back();

  // FILE_FLAG_BACKUP_SEMANTICS is required to open a DIRECTORY handle at all; OVERLAPPED is what
  // lets the worker wait on a stop event beside the read instead of blocking uninterruptibly.
  const HANDLE directory = ::CreateFileW(
      wide.c_str(), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED, nullptr);
  if (directory == INVALID_HANDLE_VALUE) {
    write_error(err, errlen, "could not open the directory", ::GetLastError());
    return nullptr;
  }

  auto *w = new host_watch();
  w->directory = directory;
  w->completion = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
  w->stop = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (w->completion == nullptr || w->stop == nullptr) {
    write_error(err, errlen, "could not create the watch events", ::GetLastError());
    host_watch_close(w);
    return nullptr;
  }

  // 🔴 NATIVE separators, deliberately. Every JavaScript consumer builds the paths it compares against
  // with `path.join`, which is backslashed here; handing back a forward-slashed twin makes each of
  // those comparisons silently false — an event that arrives but never matches, which reads exactly
  // like a watcher that is not firing. Tidiness is not worth a whole class of invisible mismatch.
  w->root.assign(path);
  while (!w->root.empty() && (w->root.back() == '/' || w->root.back() == '\\')) w->root.pop_back();
  for (char &c : w->root)
    if (c == '/') c = '\\';

  for (int32_t i = 0; i < ignore_count && ignore_dirs != nullptr; ++i)
    if (ignore_dirs[i] != nullptr) w->ignore.insert(ignore_dirs[i]);

  w->worker = std::thread(run, w);
  return w;
}

int32_t host_watch_poll(host_watch *w, char *buf, int32_t buflen, char *err, int32_t errlen) {
  if (w == nullptr || buf == nullptr || buflen <= 0) {
    write_error(err, errlen, "poll called with no watch or no buffer", 0);
    return -1;
  }
  std::lock_guard<std::mutex> guard(w->lock);
  int32_t written = 0;
  while (!w->queue.empty()) {
    const Record &record = w->queue.front();
    const int32_t needed = static_cast<int32_t>(1 + record.path.size() + 1);
    // ⚠️ Never write a partial record: a caller cannot tell a truncated path from a real one, and a
    // half-path is a wrong answer rather than a missing one. It stays queued for the next call.
    if (written + needed > buflen) break;
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

  // 1 — no new reads. Release-ordered so the worker's acquire load sees it.
  w->stopping.store(true, std::memory_order_release);
  if (w->stop != nullptr) ::SetEvent(w->stop);
  // 2 — release a read already in flight, so the worker is not parked in WaitForMultipleObjects.
  if (w->directory != INVALID_HANDLE_VALUE) ::CancelIoEx(w->directory, nullptr);
  // 3 — JOIN. Past this line, no other thread can touch `w`. Every step below depends on it.
  if (w->worker.joinable()) w->worker.join();
  // 4 — only now are the handles unreferenced.
  if (w->directory != INVALID_HANDLE_VALUE) ::CloseHandle(w->directory);
  if (w->completion != nullptr) ::CloseHandle(w->completion);
  if (w->stop != nullptr) ::CloseHandle(w->stop);
  // 5 — and only now is the struct.
  delete w;
}

}  // extern "C"

#endif  // _WIN32
