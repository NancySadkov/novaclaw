export * as Host from "./host.node"

/**
 * The Node twin of the host module.
 *
 * 🔴 WHY THIS EXISTS. The shipped desktop app runs its server as an Electron `utilityProcess`, which
 * is Node — and `bun:ffi` does not exist there. When `@parcel/watcher` was replaced, the sidecar's
 * module graph reached a `bun:` import and died at load; `build-node.ts`'s guard caught it, and the
 * fix that only silenced the guard would have left the desktop app with NO file watching at all,
 * silently, while every test passed. That is precisely the failure this whole programme is about.
 *
 * ⚠️ **This is a runtime-capability twin, NOT a second architecture.** `#sqlite`, `#pty` and `#fff`
 * already work exactly this way, and both twins implement the SAME interface — the queue-and-drain
 * shape declared in `include/host.h`, never a callback into the runtime. What differs is only who
 * fills the queue: `ReadDirectoryChangesW`/`inotify` through our own C++ under Bun, and Node's
 * built-in `fs.watch` here. No dependency is added by this file; the real end-state is ONE runtime
 * for the sidecar, and that is stated here rather than pretended away.
 *
 * ⚠️ Two differences a caller must know about, because pretending they do not exist is how a watcher
 * silently goes stale:
 *   · **No overflow signal.** `fs.watch` has no equivalent of the OS telling us it dropped events,
 *     so this twin never emits `overflow`. After a bulk operation (a branch switch, an install) a
 *     consumer here can be stale in a way the Bun path would have reported.
 *   · **`rename` is create-or-delete**, and Node does not say which. Classified by an existence
 *     check at the moment the event arrives — see `classify`.
 */

import fs from "node:fs"
import path from "node:path"
import { ignored, type Watch, type WatchEvent, type WatchOptions } from "./wire"

export type { Watch, WatchEvent, WatchEventType, WatchOptions } from "./wire"
export { decode } from "./wire"

/**
 * Matches the C ABI's version so a reader comparing the two twins sees one number, not two.
 * Nothing here loads a library, so nothing here can be skewed against one — it is stated for parity.
 */
export const ABI_VERSION = 2

/**
 * Always true: `fs.watch` is part of the runtime, so there is no library to be missing.
 *
 * ⚠️ Deliberately NOT the `fff.node.ts` posture of `available() = false`. That module answers false
 * because there is genuinely no fuzzy-finder on Node; there IS a file watcher on Node, and returning
 * false here would turn a working capability into a dead one for the app we actually ship.
 */
export const available = (): boolean => true

/**
 * Turn one `fs.watch` event into ours.
 *
 * `change` is unambiguous. `rename` means the name appeared or disappeared and Node will not say
 * which, so existence at this instant decides. ⚠️ That is a RACE by nature — a file created and
 * removed between the event and this check reads as a delete — and the alternative (reporting
 * `rename` verbatim) would push the same race onto every caller instead of resolving it once here.
 */
const classify = (event: string, full: string): WatchEvent["type"] => {
  if (event === "change") return "update"
  return fs.existsSync(full) ? "create" : "delete"
}

export const watch = (directory: string, options?: WatchOptions): Watch => {
  const root = path.resolve(directory).replace(/[/\\]+$/, "")
  const names = new Set(options?.ignoreDirectories ?? [])
  // Bounded, and it drops the OLDEST — the same policy as the C queue. A drain that fell behind
  // during a bulk operation should lose the stale beginning, not the recent end that describes the
  // tree as it is now.
  const limit = 8192
  let queue: WatchEvent[] = []
  let closed = false

  const watcher = fs.watch(
    root,
    // `persistent: false` so a watch cannot by itself keep the process alive. An instrument that
    // extends the lifetime of what it observes is a defect, and the sidecar's server holds the loop.
    { recursive: true, persistent: false },
    (event, filename) => {
      if (closed || filename === null) return
      const full = path.join(root, filename.toString())
      if (ignored(names, root, full)) return
      if (queue.length >= limit) queue.shift()
      queue.push({ type: classify(event, full), path: full })
    },
  )
  // A watch on a directory that later disappears emits an error rather than throwing; swallowing it
  // keeps a vanished folder from taking the process down, and the empty queue is what the caller sees.
  watcher.on("error", () => {})

  return {
    poll: () => {
      if (closed) return []
      const drained = queue
      queue = []
      return drained
    },
    close: () => {
      // Idempotent, matching the C entry point: a second close must not throw, and a poll after
      // close must not read a watcher that is gone.
      if (closed) return
      closed = true
      queue = []
      watcher.close()
    },
  }
}
