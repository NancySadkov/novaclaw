export * as ProjectFileResolve from "./project-file"

import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { FSUtil } from "./fs-util"

/**
 * Find the `novaclaw.json` that governs a session's working folder.
 *
 * The nearest declaration inside the location's trusted containment root governs the folder. A
 * folder without one remains usable but is not silently registered as a Project.
 *
 * ⚠️ Still not an entity. This answers a question about a directory; nothing is persisted. The
 * shared cache supplies `core/src/project.ts`'s derived worktree only as the trusted walk boundary.
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
  | {
      readonly kind: "invalid"
      readonly file: string
      /**
       * The enforcement classification. `reason` remains the parser/presentation detail, while
       * this field keeps a filesystem read failure distinct from malformed bytes and keeps a file
       * written by a newer build distinct from both.
       */
      readonly failure: "invalid" | "future-version" | "unreadable"
      readonly reason: string
      readonly detail: string
    }
  /** No file at or above the folder, within the boundary. The folder is usable, just not a Project. */
  | { readonly kind: "none" }

export interface WalkOptions {
  /** Absolute directory to start from. */
  readonly from: string
  /**
   * The trusted containment root, inclusive. This is deliberately required: a resolver that does
   * not know the selected working/repository root has no authority to inspect arbitrary ancestors.
   *
   * If it is not an ancestor of `from`, the effective boundary is `from` itself. That fallback is
   * the selected location root, never the filesystem root or a common string ancestor.
   */
  readonly boundary: string
}

export interface LocationBoundary {
  /** The selected working folder. */
  readonly directory: string
  /** The derived VCS/path root. */
  readonly root: string
  /** Present only when `root` is a repository boundary trusted by location resolution. */
  readonly vcs?: { readonly type: "git" }
}

/**
 * One definition of a location's project-file boundary for the cache and HTTP presentation path.
 * Inside a repository the discovered worktree is the trusted shared root; where there is no project
 * root at all, the user's HOME directory is the floor.
 *
 * 🔴 **This tests whether `root` IS a volume root, rather than inferring it from the absence of a
 * VCS — and the difference was a real regression.** The rule was `vcs === undefined ? directory :
 * root`, whose reasoning was *"outside a repository, `Location.root` is a volume root"*. That premise
 * is true for `Project.resolve`'s own fallback (`path.parse(input).root`) and FALSE whenever a
 * project root was established by other means — a location constructed with an explicit project
 * directory has a perfectly good non-repository root. Using the VCS flag as a PROXY for "the root is
 * meaningless" therefore collapsed the boundary onto the selected folder for every such location, and
 * a `novaclaw.json` one directory up governed nothing.
 *
 * ⚠️ **A proxy for a premise is only as good as the premise, and this one is cheap to test
 * directly:** a path is a volume root exactly when it is its own `path.parse().root`. So the check
 * now says what the comment always claimed.
 *
 * 🔴 **Outside a repository the floor is HOME, and this was re-derived the hard way.** The rule
 * briefly became "the selected folder" — which does not tighten the feature, it switches it off: a
 * project file governs the folders BENEATH it, so bounding at the selected folder leaves it
 * governing only its own. Three pre-existing tests say so, across two units and at two levels —
 * `httpapi-project-write-invalidates.test.ts` (a session in `<root>/sub` picks up a file written at
 * `<root>`), `skill-invocation-command-list.test.ts`, and the exclusion suite.
 *
 * ⚠️ **Home is the floor because of what is ABOVE it, not what is below.** Walking past home reaches
 * \`C:\\Users` or `/`, where one stray `novaclaw.json` would govern every session on the
 * machine. `snapshot.ts` draws the same line for the same reason. Principle 13 is why the remaining
 * exposure is tolerable rather than lax: a project file may only ever NARROW, so the worst a
 * surprising ancestor can do is take capability away.
 *
 * ⚠️ `bounded()` clamps a boundary that is not an ancestor of the start folder back to that folder,
 * so a directory outside home stays bounded by itself rather than by nothing.
 */
export function trustedBoundary(location: LocationBoundary): string {
  return isVolumeRoot(location.root) ? os.homedir() : location.root
}

/** `C:\`, `\server\share\`, `/` — a boundary that would trust the entire volume. */
function isVolumeRoot(candidate: string): boolean {
  const resolved = path.resolve(FSUtil.windowsPath(candidate))
  return samePath(resolved, path.parse(resolved).root)
}

function bounded(options: WalkOptions): { readonly from: string; readonly boundary: string } {
  const from = path.resolve(FSUtil.windowsPath(options.from))
  const requested = path.resolve(FSUtil.windowsPath(options.boundary))
  return { from, boundary: FSUtil.contains(requested, from) ? requested : from }
}

const samePath = (left: string, right: string) => path.relative(left, right) === ""

const resolutionFromText = (file: string, text: ReadResult): Resolution | undefined => {
  if (text === undefined) return undefined
  if (typeof text === "object")
    return {
      kind: "invalid",
      file,
      failure: "unreadable",
      reason: "unreadable",
      detail: text.detail,
    }
  const parsed = ProjectFile.parse(text)
  if (parsed.ok) return { kind: "project", root: path.dirname(file), file, info: parsed.info }
  return {
    kind: "invalid",
    file,
    failure: parsed.reason === "future-version" ? "future-version" : "invalid",
    reason: parsed.reason,
    detail: parsed.detail,
  }
}

/**
 * The walk, with reading injected so it can be tested without a filesystem.
 *
 * `read` returns the file's text, `undefined` only when it is absent, or an `unreadable` result for
 * every other I/O failure.
 */
export type ReadResult = string | undefined | { readonly kind: "unreadable"; readonly detail: string }

export function walk(options: WalkOptions, read: (file: string) => ReadResult): Resolution {
  const plan = bounded(options)
  const boundary = plan.boundary
  let dir = plan.from
  for (;;) {
    const file = path.join(dir, FILENAME)
    const result = resolutionFromText(file, read(file))
    if (result !== undefined)
      return result.kind === "project" ? { ...result, root: dir } : result
    // The boundary is checked AFTER reading, so a `novaclaw.json` in the trusted root itself counts;
    // one in its parent never does.
    if (samePath(dir, boundary)) return { kind: "none" }
    const parent = path.dirname(dir)
    // Defensive fixed-point guard. `bounded` makes the trusted boundary reachable first, but this
    // keeps a platform path quirk from turning a security check into an infinite loop.
    if (samePath(parent, dir)) return { kind: "none" }
    dir = parent
  }
}

/**
 * The same walk against the real filesystem.
 *
 * Not-found is the one read outcome that means "keep walking". Every other I/O failure stops at the
 * file and remains distinguishable from malformed bytes: a temporary lock or ACL error must never
 * erase the constraints the nearest project file may contain.
 */
export const resolve = Effect.fn("ProjectFile.resolve")(function* (from: string, boundary: string) {
  const fs = yield* FSUtil.Service
  const texts = new Map<string, ReadResult>()
  // Compare what the paths NAME ON DISK, not their spellings. This folds symlinks/junctions,
  // mapped drives, UNC aliases, 8.3 names and on-disk casing. If canonicalisation itself is denied,
  // the safe fallback is still the selected folder alone; a failed realpath may never widen a walk.
  const canonical = (value: string) => {
    try {
      return { path: FSUtil.canonical(value), trusted: true } as const
    } catch {
      return { path: path.resolve(FSUtil.windowsPath(value)), trusted: false } as const
    }
  }
  const start = canonical(from)
  const requested = canonical(boundary)
  const plan = bounded({
    from: start.path,
    boundary: start.trusted && requested.trusted ? requested.path : start.path,
  })
  return yield* resolveWith(plan, (file) =>
    fs.readFileStringSafe(file).pipe(
      Effect.match({
        onFailure: (error) => ({ kind: "unreadable" as const, detail: error.message }),
        onSuccess: (text) => text,
      }),
    ),
  )
})

/** The real-filesystem loop with its reader injected, so nearest-stop I/O is testable. */
export const resolveWith = Effect.fn("ProjectFile.resolveWith")(function* (
  options: WalkOptions,
  read: (file: string) => Effect.Effect<ReadResult>,
) {
  const plan = bounded(options)
  let dir = plan.from
  const limit = plan.boundary
  for (;;) {
    const file = path.join(dir, FILENAME)
    const result = resolutionFromText(file, yield* read(file))
    if (result !== undefined) return result
    if (samePath(dir, limit)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { kind: "none" as const }
})
