export * as Snapshot from "./snapshot"

import { makeLocationNode } from "./effect/app-node"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { File } from "./file"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath, RelativePath } from "./schema"
import { Hash } from "./util/hash"

export const ID = Schema.String.pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "preview", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * B11 — default excludes written to a SHADOW repo's info/exclude when the project is
 * not itself a git repository (there are no project ignore rules to inherit, and
 * staging node_modules-class trees would make every capture pathological).
 */
export const SHADOW_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".cache/",
  "*.log",
].join("\n")

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Interface {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  readonly capture: () => Effect.Effect<ID | undefined>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Preview the filesystem result of a selective restore without modifying the
   * worktree. Each project-relative path maps to the tree it would be restored
   * from.
   */
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>

  /**
   * Replace the snapshot index with a captured tree and check out all its entries.
   * Files absent from the tree remain untouched. Prefer selective `restore` when
   * only known paths should change.
   */
  readonly checkout: (snapshot: ID) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Snapshot") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const source = yield* git.repo.discover(location.root)
    // Non-git fallback is the LOCATION directory, not project.directory: the synthetic
    // "global" project roots at HOME, which the B11 shadow guard rightly refuses — the
    // shadow repo should track exactly where the agent works.
    const worktree = source
      ? AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
      : AbsolutePath.make(location.directory)
    // Keyed on `origin` — the same string the old project id carried, so existing snapshot repos survive.
    const gitDirectory = AbsolutePath.make(path.join(global.data, "snapshot", location.origin, Hash.fast(worktree)))

    const scope = Effect.fnUntraced(function* () {
      const relative = path.relative(worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    // B11 guard: never shadow-track a filesystem root or the home directory — a
    // first capture there would stage the user's world into the snapshot store.
    const unsafeShadowWorktree =
      path.parse(worktree).root === worktree || path.resolve(worktree) === path.resolve(os.homedir())

    // The repo's exclude rules. Beyond the static junk-dir set: when the app's OWN data
    // directory (this snapshot store, the DB, logs) lives INSIDE the worktree — novaclaw
    // opened in $HOME, or any cwd that contains the data root — tracking it makes every
    // capture stage the snapshot repo's own objects: a compounding feedback loop that turns
    // end-of-turn diffs pathological (observed: an 1860-file, ~40s diff after two turns).
    const excludes = () => {
      const lines = [SHADOW_EXCLUDES]
      const dataRelative = path.relative(worktree, global.data)
      if (dataRelative && !dataRelative.startsWith("..") && !path.isAbsolute(dataRelative)) {
        lines.push("/" + dataRelative.replaceAll("\\", "/") + "/")
      }
      return lines.join("\n")
    }

    const writeExcludes = Effect.promise(async () => {
      await fsp.mkdir(path.join(gitDirectory, "info"), { recursive: true })
      await fsp.writeFile(path.join(gitDirectory, "info", "exclude"), excludes())
    })

    const repository = Effect.fnUntraced(function* () {
      if (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
        return new Git.Repository({
          worktree,
          gitDirectory,
          commonDirectory: gitDirectory,
        })
      if (!source) {
        // B11: non-git projects get a SHADOW repo so the git-substrate undo (per-turn
        // snapshots + revert) covers any opened folder, not just git checkouts.
        if (unsafeShadowWorktree)
          return yield* new Error({
            operation: "capture",
            message: `Refusing to shadow-track ${worktree} (filesystem root / home directory)`,
          })
        const created = yield* git.repo
          .create({ worktree, gitDirectory })
          .pipe(Effect.mapError((cause) => failure("capture", cause)))
        yield* writeExcludes
        return created
      }
      const seeded = yield* git.repo
        .create({
          worktree,
          gitDirectory,
          seed: source,
        })
        .pipe(Effect.mapError((cause) => failure("capture", cause)))
      // Git-seeded repos inherit the project's ignore rules, which never cover the app data
      // dir — write the same exclude file (info/exclude is additive to inherited ignores).
      yield* writeExcludes
      return seeded
    })

    const enabled = Effect.fnUntraced(function* () {
      if (Config.latest(yield* config.entries(), "snapshots") === false) return false
      if (location.vcs?.type === "git") return true
      // B11: snapshots for non-git projects ride the shadow repo (guarded above).
      return !unsafeShadowWorktree
    })

    const capture = Effect.fn("Snapshot.capture")(function* () {
      if (!(yield* enabled())) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.capture({
            repository: repo,
            scopes: [yield* scope()],
            ignores: source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure(operation, cause)))
      return { repository: repo, from: Git.TreeID.make(input.from), to: Git.TreeID.make(input.to) }
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      const comparison = yield* compare("files", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("files", cause)))
      if (!source) return files
      const ignored = yield* git.index
        .ignored({ repository: source, paths: files })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      return files.filter((file) => !ignored.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      const comparison = yield* compare("diff", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("diff", cause)))
      const ignored = source
        ? yield* git.index
            .ignored({ repository: source, paths: files })
            .pipe(Effect.mapError((cause) => failure("diff", cause)))
        : new Set<RelativePath>()
      return yield* git.tree
        .diff({
          ...comparison,
          context: input.context,
          paths: (input.paths ?? files).filter((file) => !ignored.has(file)),
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (operation: "preview" | "restore", input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(worktree, file)
        if (!FSUtil.contains(worktree, absolute))
          return yield* new Error({ operation, message: `Path escapes the project: ${file}` })
        files.set(file, Git.TreeID.make(snapshot))
      }
      return files
    })

    const preview = Effect.fn("Snapshot.preview")(function* (input: PreviewInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "preview", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("preview", cause)))
      const files = yield* plan("preview", input)
      const current = yield* git.tree
        .capture({
          repository: repo,
          scopes: Array.from(files.keys()),
          ignores: source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
      return yield* git.tree
        .preview({
          repository: repo,
          current,
          files,
          context: input.context,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .restore({ repository: repo, files: yield* plan("restore", input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const checkout = Effect.fn("Snapshot.checkout")(function* (snapshot: ID) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .checkout({ repository: repo, tree: Git.TreeID.make(snapshot) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    return Service.of({ capture, files, diff, preview, restore, checkout })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Git.node, Global.node, Location.node],
})

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
