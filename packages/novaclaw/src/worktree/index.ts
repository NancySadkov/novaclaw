import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { path } from "@novaclaw/core/effect/app-node-platform"
import { Global } from "@novaclaw/core/global"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceStore } from "@/project/instance-store"
import { Database } from "@novaclaw/core/database/database"
import { eq } from "drizzle-orm"
import { Slug } from "@novaclaw/core/util/slug"
import { errorMessage } from "../util/error"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Effect, Layer, Path, Schema, Scope, Context } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { AppProcess } from "@novaclaw/core/process"
import { InstanceState } from "@/effect/instance-state"
import { WorktreeEvent } from "@novaclaw/schema/worktree-event"
import { Log } from "@novaclaw/schema/log"

export const Event = WorktreeEvent

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
  /**
   * 🔴 **Destroy uncommitted work. Defaults to FALSE, and that default is the point.**
   *
   * Until 2026-08-07 this field did not exist and `git worktree remove --force` was hardcoded, so a
   * worktree with uncommitted changes was deleted silently, with no confirmation and no way to ask
   * for the safe behaviour. Git has a guard for exactly this and it was switched off at the one call
   * site that would have used it.
   *
   * ⚠️ **A flag that defaults to destructive is the same defect with a longer signature.** Callers
   * that genuinely mean it pass `force: true` explicitly, which makes the destructive choice visible
   * at the site that intends it rather than invisible in this module.
   *
   * The pre-2.0 HTTP surface had this as `force`, and answered `400 {forceRequired: true}` — the
   * behaviour was lost in a migration rather than deliberately dropped.
   */
  force: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

/**
 * 🔴 The SAFE refusal: the worktree holds work that removing it would discard.
 *
 * Distinct from `RemoveFailedError` on purpose — this is not a failure, it is the guard working, and
 * a caller can convert it into a completed removal by asking again with `force`. Folding it into
 * `RemoveFailedError` would tell the operator "removal failed" for something that has not failed and
 * would lose the one piece of information that makes it actionable.
 */
export class DirtyWorktreeError extends Schema.TaggedErrorClass<DirtyWorktreeError>()("WorktreeDirtyError", {
  directory: Schema.String,
  message: Schema.String,
}) {}

/**
 * 🔴 The CONTAINMENT refusal: the caller named a directory that is not one of ours to delete.
 *
 * `remove` used to answer `true` — "removed" — for **any** directory git did not recognise as a
 * worktree, after recursively deleting it. A caller naming `C:\Users\<name>\Documents` got it erased
 * and a success back. That is AGENTS.md principle 11 head-on: NovaClaw writes and deletes in the home
 * instance dirs, the OS temp dir and the session's own folder, and nowhere else.
 *
 * Distinct from `RemoveFailedError` for the same reason {@link DirtyWorktreeError} is: nothing
 * failed. The request was refused, nothing on disk changed, and the caller needs to be able to tell
 * that apart from a removal that broke halfway — ruling 2, a failed mutation never reports success,
 * and its converse, a refusal is not described as a fault.
 *
 * ⚠️ Deliberately kept OUT of the shared `Error` union and off the `WorktreeErrorName` wire union:
 * only a removal can be refused this way, and a route that ever exposes `remove` again must handle
 * this case explicitly rather than inherit a mapping that flattens it into "worktree removal failed".
 */
export class OutsideRootError extends Schema.TaggedErrorClass<OutsideRootError>()("WorktreeOutsideRootError", {
  directory: Schema.String,
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  /**
   * ⚠️ `DirtyWorktreeError` and `OutsideRootError` are declared HERE and deliberately kept out of the
   * shared `Error` union: only a removal can be refused for holding uncommitted work, and only a
   * removal can be refused for naming a directory outside this instance's worktree root. Widening the
   * union would force every caller of `create`/`reset`/`list` to handle a case they cannot produce,
   * and — worse — would let a generic error mapper answer "worktree is dirty" for an operation where
   * that is meaningless.
   */
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error | DirtyWorktreeError | OutsideRootError>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Worktree") {}

/**
 * **`stderr` is the CHILD's words; `fault` is OURS — and they are two fields on purpose.**
 *
 * Until 2026-08-08 a caught spawn failure was written into `stderr` (`e instanceof Error ?
 * e.message : String(e)`, one of the 21 drifted shapes `Log.fault` replaces), so
 * `worktree.checkout.failed` reported our own exception as git's output. A spawn that never produced
 * a process has no stderr: ruling 2, *a fault is never described falsely*. The catch now names
 * itself under `worktree.git.spawn.failed` and leaves `stderr` empty.
 *
 * ⚠️ It still has to reach the CALLER, because worktree's `stderr` is not log-only — it is the text
 * of `CreateFailedError`/`ListFailedError`/`RemoveFailedError`/`ResetFailedError`, which a person
 * reads in the UI. Blanking it without this field would have replaced *"spawn git ENOENT"* with
 * *"Failed to create git worktree"*, which is the other half of the same ruling. See {@link reason}.
 *
 * `fault` is `""` whenever a child actually ran.
 */
type GitResult = { code: number; text: string; stderr: string; fault: string }

export const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Path.Path | AppProcess.Service | Git.Service | InstanceStore.Service | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const store = yield* InstanceStore.Service

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        // `Git.spawn`, not a local `ChildProcess.make` and not a local flag list. This helper passed
        // NO `-c` flags, so `worktree add` / `reset --hard` / `clean -ffdx` failed on Windows deep
        // trees with git's "Filename too long" while the same operation through `Git.Service`
        // succeeded — only `Git.CONFIG_ARGS` sets `core.longpaths=true`, and it is applied there.
        // What stays HERE is the return shape and the catch arm below, which is the whole reason
        // this helper still exists.
        const result = yield* Git.spawn(appProcess, args, { cwd: opts?.cwd })
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          fault: "",
        } satisfies GitResult
      },
      // 🔴 **Ruling 2.** `code: 1` is a sentinel, not an observed exit status, and the reason no
      // longer masquerades as git's stderr — it is named here, once, by the subsystem that is
      // actually unavailable. `Log.fault` is evaluated twice on this cold path deliberately: the
      // literal call at the attribute site is what `log-attributes.test.ts` reads to prove the one
      // normalization is in force, and a local would be invisible to it.
      // ⚠️ `Effect.catch` does not see a defect (measured, effect@4.0.0-beta.83) — deliberately: a
      // broken spawner must keep travelling to the `catchCause` arms rather than read as `git exited 1`.
      Effect.catch((error) =>
        Log.event("worktree.git.spawn.failed", { "worktree.cause": Log.fault(error) }).pipe(
          Effect.as({ code: 1, text: "", stderr: "", fault: Log.fault(error) } satisfies GitResult),
        ),
      ),
    )

    /**
     * **What the CHILD said** — its own stderr, else its own stdout. Never our caught spawn failure.
     *
     * This is the value a log column named for a foreign process may hold, which is what lets
     * `worktree.checkout.failed` and `worktree.start.command.failed` be classed `text` rather than
     * `fault`. On a spawn failure it is `""`, and the `…spawn.failed` line above it says why.
     */
    const childOutput = (result: GitResult) => result.stderr || result.text

    /**
     * **Why a git invocation produced nothing usable, for a PERSON** — the child's words, then our
     * caught spawn failure, then a constant.
     *
     * Two readers, two renderings, and the split is the point (the same one `boot` already makes for
     * its bus payload): a user-facing error has no second line to carry the spawn failure, so it
     * takes `fault` here; a log line does, so it takes {@link childOutput} and the fault arrives
     * under its own key.
     */
    const reason = (result: GitResult, fallback: string) => childOutput(result) || result.fault || fallback

    /**
     * **Where this instance's worktrees live — `<data>/worktree/<origin>`.**
     *
     * One definition, because two would drift and the drift would be invisible: `makeWorktreeInfo`
     * builds every worktree path under this root, and `remove` refuses to delete anything that is not
     * under it. A second spelling of the root in either place is a guard that has quietly stopped
     * matching the thing it guards.
     */
    const worktreeRootPath = (origin: string) => pathSvc.join(Global.Path.data, "worktree", origin)

    /**
     * The same root, created if absent — for the side that PUTS worktrees there.
     *
     * ⚠️ Kept separate from {@link worktreeRootPath} on purpose: `remove`'s containment check must not
     * create a directory while refusing a request. It does not need to, either. A root that does not
     * exist cannot contain a directory that does, so an absent root makes the check fail closed —
     * which is the answer a guard should give when it cannot see its own boundary.
     */
    const ensureWorktreeRoot = Effect.fnUntraced(function* (origin: string) {
      const root = worktreeRootPath(origin)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
      return root
    })

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `novaclaw/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const root = yield* ensureWorktreeRoot(ctx.origin)

      // Slug.from's cap is load-bearing here: `name` becomes both a directory component under
      // Global.Path.data and a `novaclaw/<name>` branch ref, and a caller-supplied name arrives over
      // HTTP. A local copy of this function without the cap produced unbounded worktree paths.
      return yield* candidate({ root, name: input?.name ? Slug.from(input.name) : "", detached: input?.detached })
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        { cwd: ctx.worktree },
      )
      if (created.code !== 0) {
        return yield* new CreateFailedError({ message: reason(created, "Failed to create git worktree") })
      }
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const extra = startCommand?.trim()

      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        // The UI gets the whole reason including a caught spawn failure; the log column gets only
        // git's own words, because it is declared `text` and `worktree.git.spawn.failed` has already
        // named the other case on its own line. Same split as the `errorMessage`/`Log.fault` pair
        // below — two readers, two renderings.
        const message = reason(populated, "Failed to populate worktree")
        yield* Log.event("worktree.checkout.failed", {
          "worktree.directory": info.directory,
          "worktree.cause": childOutput(populated),
        })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.origin,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Two readers, two renderings, and they are deliberately different: the bus payload
            // below is what the UI shows a person, so it stays the SHORT `errorMessage`, while the
            // log column takes the whole fault — `Log.fault` keeps the stack, which is the half
            // `.message` throws away and the half an agent repairing this instance needs.
            const message = errorMessage(error)
            yield* Log.event("worktree.bootstrap.load.failed", {
              "worktree.directory": info.directory,
              "worktree.cause": Log.fault(error),
            })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.origin,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return false
          }),
        ),
      )
      if (!booted) return

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.origin,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      yield* runStartScripts(info.directory, { extra })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      yield* boot(info, startCommand).pipe(
        Effect.catchCause((cause) =>
          Log.event("worktree.bootstrap.run.failed", {
            "worktree.directory": info.directory,
            "worktree.cause": Log.fault(cause),
          }),
        ),
        Effect.forkIn(scope),
      )
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const info = yield* makeWorktreeInfo({ name: input?.name })
      yield* createFromInfo(info, input?.startCommand)
      return info
    })

    /**
     * A path reduced for COMPARISON — lowercased on Windows, where the filesystem is case-insensitive.
     *
     * ⚠️ **Never return this to a caller.** Two names for one directory is exactly the confusion this
     * resolves internally, and handing the lowered form outward recreates it one layer up.
     */
    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    /**
     * The same path as it actually IS on disk — resolved and normalized, casing intact.
     *
     * 🔴 `list` used to return `canonical(...)`, so on Windows it answered a lower-cased path while
     * `create` answered the real one for the SAME worktree. A client cannot compare those, and one did
     * not: `httpapi-experimental.test.ts` asserts the created directory appears in the list, which is
     * why that test was **skipped on win32** — with no recorded reason, so the skip read as a platform
     * quirk rather than as the API disagreeing with itself.
     */
    const displayPath = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      return pathSvc.normalize(real)
    })

    /**
     * `canonical`, but it answers `undefined` rather than GUESSING when the path cannot be resolved.
     *
     * 🔴 The difference is the whole security property. `canonical` falls back to the lexical
     * `resolve()` when `realPath` fails, which is right for listing and display — a path we cannot
     * stat is still a path we can print. It is wrong for a containment decision, because the lexical
     * form collapses `..` *through* symlinks: with `<root>/link` a junction to `C:\Users\me`, the
     * lexical answer for `<root>/link/Documents` is "inside `<root>`" while the bytes live outside it.
     * Resolution normally closes that (the real path is compared), so the hole is exactly the arm
     * where resolution failed — an unreadable ancestor, a permission error — and there the honest
     * answer is "I cannot prove containment", not "assume the lexical form".
     */
    const canonicalReal = Effect.fnUntraced(function* (input: string) {
      const real = yield* fs.realPath(pathSvc.resolve(input)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (real === undefined) return undefined
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    /**
     * 🔴 **The ONE containment check** — is `target` a path strictly inside `base`, as they exist on
     * disk? Used by `remove` before it deletes anything git did not vouch for, and by `prune`.
     *
     * Three refusals, and each one has been a real defect somewhere:
     * - **the container itself** (`target === base`) — a "clean up under X" that deletes X;
     * - **a sibling with a shared prefix** — `…/worktree/acme-evil` is not inside `…/worktree/acme`,
     *   which is why the separator is part of the comparison rather than a bare `startsWith`;
     * - **anything that resolves outward** — `..` (collapsed by `resolve`) and symlinks/junctions
     *   (collapsed by `realPath`) both land outside and are refused on their REAL path.
     *
     * Case is folded on win32 because the filesystem is case-insensitive, so `C:\Users` and
     * `c:\users` are one directory and a case-sensitive compare would refuse a legitimate child.
     */
    const containedIn = Effect.fnUntraced(function* (base: string, target: string) {
      const root = yield* canonicalReal(base)
      const inside = yield* canonicalReal(target)
      if (root === undefined || inside === undefined) return false
      return inside !== root && inside.startsWith(`${root}${pathSvc.sep}`)
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.vcs !== "git") {
        return []
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: reason(result, "Failed to read git worktrees") })
      }

      const entries = parseWorktreeList(result.text)
      // `git worktree list --porcelain` guarantees the main worktree first. The caller may itself be
      // inside a linked worktree, so `ctx.worktree` is not a valid proxy for the project checkout.
      const primary = entries[0]?.path ? yield* canonical(entries[0].path) : yield* canonical(ctx.worktree)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          // Compare canonically, REPORT truthfully — two different jobs that were one value until
          // 2026-08-07.
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const reported = yield* displayPath(entry.path)
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory: reported,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    function stopFsmonitor(target: string) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) => (exists ? git(["fsmonitor--daemon", "stop"], { cwd: target }) : Effect.void)),
      )
    }

    function cleanDirectory(target: string) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const attempts = process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
      })
    }

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(ctx.worktree))) yield* store.disposeDirectory(input.directory)

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new RemoveFailedError({ message: reason(list, "Failed to read git worktrees") })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)

      /**
       * 🔴 **git did not vouch for this path, so nothing else may.**
       *
       * Every branch below this one deletes a directory GIT named — `entry.path` comes out of
       * `git worktree list --porcelain` for this very repository, and `git worktree remove` refuses
       * the main worktree itself. This branch has no such authority: `locateWorktree` found nothing,
       * so the only thing pointing at the directory is the caller's own string. Until 2026-09-02 it
       * recursively deleted whatever that string named and answered `true` — a caller passing their
       * Documents folder had it erased and was told the worktree was removed.
       *
       * So the delete is admitted only for a path inside `<data>/worktree/<origin>`, which is where
       * `makeWorktreeInfo` puts every worktree we create and is sanctioned place (a) under AGENTS.md
       * principle 11. The legitimate case that still reaches here is a worktree of ours whose
       * registry entry is gone (a `git worktree prune`, a half-finished removal) and whose directory
       * lingers.
       *
       * ⚠️ The order of the two conditions is deliberate. A path that does not exist is answered
       * `true` and nothing is touched — that is an idempotent removal, not a claim about the caller's
       * right to the path, and it is the answer `remove` has always given for a worktree that is
       * already gone. Only an actual delete has to be justified.
       *
       * ⚠️ `store.disposeDirectory` above runs before this check and stays there: it drops an
       * in-memory instance keyed by the directory and writes nothing, so it is not a mutation this
       * guard exists to prevent — and moving it below would skip it on the registered path.
       */
      if (!entry?.path) {
        const directoryExists = yield* fs.exists(directory).pipe(Effect.orDie)
        if (!directoryExists) return true
        if (!(yield* containedIn(worktreeRootPath(ctx.origin), directory))) {
          return yield* new OutsideRootError({
            // The CALLER's path, for the same reason `DirtyWorktreeError` carries it: the client has
            // to recognise the value it sent, not a lowercased Windows form it never wrote.
            directory: input.directory,
            message:
              `Refusing to remove ${input.directory}: it is not a worktree of this project and it is ` +
              `not inside this instance's worktree directory. Nothing was deleted.`,
          })
        }
        yield* stopFsmonitor(directory)
        yield* cleanDirectory(directory)
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path)
      // ⚠️ `--force` ONLY when the caller asked for it. Without it git refuses a worktree with
      // uncommitted changes or untracked files, which is precisely the guard we want: git already
      // knows what "dirty" means here, so detecting it ourselves would be a second, drifting answer.
      const removed = yield* git(
        input.force === true ? ["worktree", "remove", "--force", entry.path] : ["worktree", "remove", entry.path],
        { cwd: ctx.worktree },
      )
      // A refusal on the SAFE path is not a failure to report as one — it is the guard doing its job,
      // and the caller needs to be told it can retry with `force`. Git says "contains modified or
      // untracked files, use --force to delete it"; that text is git's, so match on the stable part.
      // ⚠️ `childOutput`, deliberately NOT `reason`: this matches on git's own wording, so our caught
      // spawn failure must never be able to satisfy it. A worktree we could not even ask about is not
      // a worktree we know to be dirty.
      if (
        removed.code !== 0 &&
        input.force !== true &&
        /use --force|not empty|contains modified/i.test(childOutput(removed))
      ) {
        return yield* new DirtyWorktreeError({
          // ⚠️ The CALLER's path, not git's `entry.path`. git reports worktrees with forward slashes
          // on Windows, so `entry.path` differs from the string the client passed in — and this field
          // exists so a client can retry `remove({directory, force: true})` with it. Handing back a
          // value they did not send makes the round trip a guess. (Caught by the test asserting the
          // field equals the requested directory; the message keeps git's form out of it too.)
          directory: input.directory,
          message:
            `Worktree has uncommitted changes or untracked files: ${input.directory}. ` +
            `Removing it would discard that work — retry with force to delete it anyway.`,
        })
      }
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message: reason(removed, reason(next, "Failed to remove git worktree")),
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          return yield* new RemoveFailedError({ message: reason(removed, "Failed to remove git worktree") })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* git(["branch", "-D", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0) {
          return yield* new RemoveFailedError({ message: reason(deleted, "Failed to delete worktree branch") })
        }
      }

      return true
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      // 🔴 **Ruling 2 — a fault is never described falsely, and this arm has now been wrong twice in
      // opposite directions.** It first discarded the error and answered `stderr: ""`, so
      // `worktree.start.command.failed` said the start command failed and named no reason at all.
      // The fix put `Log.fault(cause)` in `stderr` — which named the reason and filed it under a
      // false author: a spawn that never produced a process has no stderr, so the line claimed the
      // user's start command had complained when no shell was ever started.
      //
      // Both halves are the same defect. The reason belongs to the subsystem that failed, so the
      // catch names ITSELF under `worktree.start.spawn.failed` and `stderr` goes back to meaning
      // *what the shell said*, which is what makes the column below `text` rather than `fault`.
      // ⚠️ `Effect.catch` does not see defects (measured, effect@4.0.0-beta.83) — deliberately: a
      // defect here must keep travelling to the `catchCause` arms in `createFromInfo`/`reset`, which
      // name it rather than folding it into an exit code.
      Effect.catch((cause) =>
        // ⚠️ No `worktree.directory` here even though it would be useful: the pipes handed to
        // `Effect.fnUntraced` are applied OUTSIDE the generator, so the arguments are not in scope.
        // `worktree.start.command.failed` carries the directory on the line that follows this one.
        Log.event("worktree.start.spawn.failed", { "worktree.cause": Log.fault(cause) }).pipe(
          Effect.as({ code: 1, stderr: "" }),
        ),
      ),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      yield* Log.event("worktree.start.command.failed", {
        "worktree.start.kind": kind,
        "worktree.directory": directory,
        "worktree.cause": result.stderr,
      })
      return false
    })

    // T3 (entities.md): the per-project startup command died with the entity's meta — only an
    // explicitly passed start command runs now (plugins/adapters can reintroduce richer hooks).
    const runStartScripts = Effect.fnUntraced(function* (directory: string, input: { extra?: string }) {
      yield* runStartScript(directory, input.extra ?? "", "worktree")
      return true
    })

    // The entries are paths git PRINTED in a "failed to remove" warning, so they are attacker-shaped
    // only in the sense that a repository can contain anything — which is enough. `containedIn` is
    // the same predicate `remove` uses; it used to be spelled out here and nowhere else, which is how
    // `remove` came to be missing it.
    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = pathSvc.resolve(root, entry)
            if (!(yield* containedIn(root, target))) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(["clean", "-ffdx"], { cwd: root })
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context
      if (ctx.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(ctx.worktree)
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new ResetFailedError({ message: reason(list, "Failed to read git worktrees") })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path

      const base = yield* gitSvc.defaultBranch(ctx.worktree)
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        // In the WORKTREE, not the user's primary checkout: a linked worktree shares the object store
        // and the remotes, so the fetch lands the same refs, but `FETCH_HEAD` and any hook output
        // stay under the worktree's own gitdir instead of appearing in a checkout the user never
        // asked NovaClaw to touch. Principle 11: the primary checkout is read-only to us.
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: worktreePath },
          (r) => new ResetFailedError({ message: reason(r, `Failed to fetch ${base.ref}`) }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: reason(r, "Failed to reset worktree to target") }),
      )

      const cleanResult = yield* sweep(worktreePath)
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({ message: reason(cleanResult, "Failed to clean worktree") })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: reason(r, "Failed to update submodules") }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: reason(r, "Failed to reset submodules") }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: reason(r, "Failed to clean submodules") }),
      )

      const status = yield* git(["status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: reason(status, "Failed to read git status") })
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      yield* runStartScripts(worktreePath, {}).pipe(
        Effect.catchCause((cause) =>
          Log.event("worktree.start.task.failed", {
            "worktree.directory": worktreePath,
            "worktree.cause": Log.fault(cause),
          }),
        ),
        Effect.forkIn(scope),
      )

      return true
    })

    return Service.of({ makeWorktreeInfo, createFromInfo, create, list, remove, reset })
  }),
)

export const appLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(NodePath.layer),
)

export const defaultLayer = appLayer.pipe(Layer.provide(InstanceLayer.layer))

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, path, AppProcess.node, Git.node, InstanceStore.node, Database.node],
})

export * as Worktree from "."
