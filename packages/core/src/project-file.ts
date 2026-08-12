export * as ProjectFileResolve from "./project-file"

import path from "node:path"
import os from "node:os"
import { Effect } from "effect"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { FSUtil } from "./fs-util"

/**
 * Find the `novaclaw.json` that governs a session's working folder.
 *
 * `todo/projects.md`: *"Resolve the nearest valid `novaclaw.json` at or above the session folder as
 * its Project root. A folder without one remains usable but is not silently registered as a
 * Project."*
 *
 * ⚠️ Still not an entity. This answers a question about a directory; nothing is persisted, and
 * `core/src/project.ts`'s VCS-root derivation is unrelated and unchanged.
 */

export const FILENAME = "novaclaw.json"

export type Resolution =
  /** A project governs this folder. `root` is the directory holding the file. */
  | { readonly kind: "project"; readonly root: string; readonly file: string; readonly info: ProjectFile.Info }
  /**
   * A `novaclaw.json` was found and could not be used.
   *
   * 🔴 The walk STOPS here rather than continuing upward, and that is a deliberate reading of "the
   * nearest valid one". A file the user put in this folder is a statement of intent; skipping past it
   * to a grandparent's would apply settings they did not ask for while their own edit did nothing and
   * said nothing. A broken file is a thing to report, not a thing to route around.
   */
  | { readonly kind: "invalid"; readonly file: string; readonly reason: string; readonly detail: string }
  /** No file at or above the folder, within the boundary. The folder is usable, just not a Project. */
  | { readonly kind: "none" }

export interface WalkOptions {
  /** Absolute directory to start from. */
  readonly from: string
  /**
   * Where to stop, inclusive. Defaults to the user's home directory.
   *
   * ⚠️ NOT the filesystem root. Walking past home reaches `C:\Users` or `/`, where a stray
   * `novaclaw.json` — or one belonging to a different user — would silently govern every session on
   * the machine. `snapshot.ts` already treats home as the boundary for the same reason.
   */
  readonly boundary?: string
}

/**
 * The walk, with reading injected so it can be tested without a filesystem.
 *
 * `read` returns the file's text, or `undefined` when there is no file there.
 */
export function walk(options: WalkOptions, read: (file: string) => string | undefined): Resolution {
  const boundary = path.resolve(options.boundary ?? os.homedir())
  let dir = path.resolve(options.from)
  for (;;) {
    const file = path.join(dir, FILENAME)
    const text = read(file)
    if (text !== undefined) {
      const parsed = ProjectFile.parse(text)
      if (parsed.ok) return { kind: "project", root: dir, file, info: parsed.info }
      return { kind: "invalid", file, reason: parsed.reason, detail: parsed.detail }
    }
    // The boundary is checked AFTER reading, so a `novaclaw.json` in the boundary directory itself
    // still counts. A user who puts one at `~` meant it; what they cannot have meant is one above.
    if (dir === boundary) return { kind: "none" }
    const parent = path.dirname(dir)
    // `path.dirname` is its own fixed point at a filesystem root, which is the only stop condition
    // available when `from` is outside the boundary entirely (a session opened on another drive).
    if (parent === dir) return { kind: "none" }
    dir = parent
  }
}

/**
 * The same walk against the real filesystem.
 *
 * ⚠️ Reads with `readFileStringSafe`, so an unreadable file — permissions, a race with a delete —
 * is `undefined` and the walk CONTINUES upward. That is different from a file that exists and is
 * malformed, which stops it: "I cannot see it" and "it is broken" are not the same statement, and
 * only the second is something the user can act on.
 */
export const resolve = Effect.fn("ProjectFile.resolve")(function* (from: string, boundary?: string) {
  const fs = yield* FSUtil.Service
  const texts = new Map<string, string | undefined>()
  // Two passes: collect the candidate paths, read them, then run the pure walk over what was read.
  // The alternative — an Effect-shaped loop — would put the interesting logic somewhere it cannot be
  // tested without a filesystem, which is where it was easiest to get wrong.
  let dir = path.resolve(from)
  const limit = path.resolve(boundary ?? os.homedir())
  for (;;) {
    const file = path.join(dir, FILENAME)
    texts.set(file, yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined)))
    if (dir === limit) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return walk({ from, boundary }, (file) => texts.get(file))
})
