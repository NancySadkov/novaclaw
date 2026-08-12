/*
 * host.h — NovaClaw's own host-interfacing module.
 *
 * ⭐ OWNER RULING, 2026-08-12: *"create a single C++ host module, exporting api through host.h. This
 * module will replace countless of these crufty nodejs deps. Now we will build it ourselves and will
 * be able to debug properly."*
 *
 * The reason is concrete rather than stylistic. A segfault arrived from `@parcel/watcher`'s
 * `watcher.node` on Windows; the shipped binary has no PDB, its build lives on somebody else's CI
 * runner (`D:\a\watcher\watcher\build\Release\watcher.pdb`), and the matching upstream report is
 * closed as *not planned*. There was no path from "it crashed" to "here is the line". Owning the
 * source, the flags and the symbols is what makes that class of fault fixable at all.
 *
 * ─── the two shape decisions, and why ──────────────────────────────────────────────────────────
 *
 * 1. **A plain C ABI shared library, loaded through `bun:ffi` — NOT an N-API addon.** N-API is the
 *    boundary the crash sits on (the upstream issue frames it as the runtime's teardown of a native
 *    module), and it drags in node-gyp, prebuild tooling and a per-runtime ABI. A C header plus
 *    `dlopen` needs none of that: `g++ -shared` and this file are the whole contract. C++ inside,
 *    `extern "C"` at the edge.
 *
 * 2. **Nothing here ever calls back into JavaScript.** Every subsystem that produces events buffers
 *    them on its own thread and the caller DRAINS them. Calling into a JS runtime from a foreign
 *    thread is the single most reliable way to produce the segfaults this module exists to escape,
 *    and a poll costs one syscall-free memcpy. If a future capability seems to need a callback, it
 *    needs a queue instead.
 *
 * ─── conventions every entry point obeys ───────────────────────────────────────────────────────
 *
 * · Opaque handles. The caller never sees a struct layout, so adding a field is not an ABI break.
 * · No allocation crosses the boundary. The caller owns every buffer it passes; this library never
 *   hands back memory the caller must free, so there is no free-with-the-wrong-allocator bug class.
 * · Errors are written into a caller-supplied buffer and signalled by the return value. No errno,
 *   no thread-local last-error, nothing to race.
 * · Every `*_close` is idempotent and safe on NULL.
 */
#ifndef NOVACLAW_HOST_H
#define NOVACLAW_HOST_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define HOST_EXPORT __declspec(dllexport)
#else
#define HOST_EXPORT __attribute__((visibility("default")))
#endif

/*
 * Bumped whenever an existing entry point changes meaning or signature.
 *
 * ⚠️ The JS side must CHECK this before using anything else. A stale `host.dll` beside a newer build
 * is the normal outcome of a partial rebuild, and calling a changed function through an old binary
 * is exactly the undebuggable crash this module exists to remove — so it is a refusal at load, not a
 * mystery at runtime.
 */
#define HOST_ABI_VERSION 2
HOST_EXPORT int32_t host_abi_version(void);

/* ─── file watching ─────────────────────────────────────────────────────────────────────────────
 *
 * Replaces `@parcel/watcher` for the one shape NovaClaw actually uses: watch a directory tree,
 * report create/update/delete, stop cleanly.
 */

/** What happened to a path. Values are stable — they cross the ABI. */
typedef enum {
  HOST_WATCH_CREATE = 1,
  HOST_WATCH_UPDATE = 2,
  HOST_WATCH_DELETE = 3,
  /*
   * The OS dropped events: more changes arrived than its buffer could hold.
   *
   * ⚠️ This is a FIRST-CLASS event, not an error, and a caller that ignores it is silently wrong
   * after any bulk operation (a branch switch, an `npm install`). It means "your picture of this
   * tree is stale — rescan"; no path accompanies it.
   */
  HOST_WATCH_OVERFLOW = 4
} host_watch_event;

typedef struct host_watch host_watch;

/**
 * Start watching `path` and everything under it.
 *
 * `ignore_dirs` is an array of `ignore_count` directory NAMES (not globs, not paths) — any event
 * whose path has one of them as a segment BELOW the root is dropped before it is ever queued.
 *
 * ⚠️ **Segments, and only below the root.** `node_modules` churn is the volume this exists to
 * discard, and matching the root's own ancestry would be a bug with teeth: watching
 * `/home/me/build/project` must not ignore the entire tree because an ancestor happens to be called
 * `build`. The caller's richer rules (file globs, whitelists) stay in the caller — this is the cheap
 * high-volume half, placed here so the noise never wakes the runtime at all.
 *
 * Returns NULL on failure and writes a human-readable reason into `err` (NUL-terminated, truncated
 * to `errlen`). `err` may be NULL if the caller does not want the reason.
 */
HOST_EXPORT host_watch *host_watch_open(const char *path, const char *const *ignore_dirs, int32_t ignore_count,
                                        char *err, int32_t errlen);

/**
 * Drain queued events into `buf`.
 *
 * The encoding is deliberately trivial so the JS side needs no parser generator: each record is
 *
 *     [1 byte: host_watch_event][UTF-8 path][1 byte: 0]
 *
 * and `HOST_WATCH_OVERFLOW` carries an empty path. Returns the number of BYTES written, 0 when
 * nothing is queued, or -1 on error (reason in `err`).
 *
 * Paths are absolute and use the platform's NATIVE separator — backslashes on Windows. A caller
 * comparing against a path it built itself must get equality without normalising, or every such
 * comparison is silently false and the watcher looks dead while it is in fact firing.
 *
 * ⚠️ Events that do not fit stay queued; call again. The buffer is never partially written with a
 * truncated record, because a caller cannot tell a truncated path from a real one.
 */
HOST_EXPORT int32_t host_watch_poll(host_watch *w, char *buf, int32_t buflen, char *err, int32_t errlen);

/**
 * Stop watching and release everything.
 *
 * ⚠️ **The teardown order is the whole point of writing this ourselves.** It signals the worker,
 * cancels the pending I/O, JOINS the thread, and only then closes handles and frees the struct.
 * Closing a handle while a completion is still in flight is precisely how a watcher faults at
 * shutdown — which is the crash that started this module.
 *
 * Safe on NULL. Safe to call twice.
 */
HOST_EXPORT void host_watch_close(host_watch *w);

#ifdef __cplusplus
}
#endif

#endif /* NOVACLAW_HOST_H */
