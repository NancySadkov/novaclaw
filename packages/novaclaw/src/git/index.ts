import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { AppProcess } from "@novaclaw/core/process"
import { binary as gitBinary } from "@novaclaw/core/git"
import { Effect, Layer, Context } from "effect"
import { ChildProcess } from "effect/unstable/process"

/**
 * THE git invocation prefix, applied by {@link spawn} and therefore by every module in this package
 * that shells out to git.
 *
 * ⚠️ The divergence had a named cost. `--no-optional-locks` is the flag that stops
 * `status`/`diff`/`ls-files` taking `index.lock`; `snapshot/` omitted it, and snapshot failures from
 * a second session running `git` in the same worktree during a snapshot are a recorded symptom.
 * `worktree/` passed no `-c` flags at all, so `worktree add`,
 * `reset --hard` and `clean -ffdx` failed on Windows deep trees ("Filename too long") where the same
 * operation through `Git.Service` succeeded, because only this list sets `core.longpaths=true`.
 *
 * Every flag is safe on write commands too — `--no-optional-locks` suppresses only the OPTIONAL
 * index refresh lock, never the real `index.lock` a commit takes — which is why this one list can be
 * unconditional rather than split per command.
 */
export const CONFIG_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  /** Data written to the child's stdin. Absent means the child gets `"ignore"`, never an open pipe. */
  readonly stdin?: AppProcess.RunOptions["stdin"]
  readonly maxOutputBytes?: number
}

/**
 * 🔴 **THE git spawn for this package.** `Git.run`, `snapshot/`'s `git()`, `worktree/`'s `git()` and
 * `snapshot/`'s raw `cat-file --batch` all come through here, so the executable name, {@link
 * CONFIG_ARGS}, `extendEnv` and the stdio policy have exactly one definition.
 *
 * ⚠️ **The seam is deliberate, and it is NOT where a de-duplication naturally lands.** Each of the
 * four callers keeps its own `Effect.catch` arm and its own return shape, because those are the two
 * things that genuinely differ and each is argued at its own site: `Git.run` synthesises a `Result`
 * with the error text in `stderr`; `snapshot`'s `git()` emits `snapshot.git.spawn.failed` and hands
 * back an EMPTY `stderr` (ruling 2 — `stderr` is the child's own words, and a spawn that produced no
 * process has none); `worktree`'s `git()` splits `childOutput` from `reason`. Two of those catch
 * arms are also read AS SOURCE by `core/test/log-attributes.test.ts`, whose scanner only sees a
 * `Log.event` with a LITERAL key — parameterising the event name would delete both sites from the
 * fault-normalization ratchet without failing anything. So what is shared is the spawn; what is
 * argued stays at the caller.
 *
 * ⚠️ **The prefix belongs HERE and not at the call sites, which is what the previous attempt got
 * wrong.** Exporting `CONFIG_ARGS` and spreading it per call site left `snapshot/` with thirteen
 * invocations carrying no flags at all (`init`, its eight `config` writes, both `rev-parse`s, `gc`,
 * `write-tree`), so the divergence this list exists to close was still open. Prefixing here makes it
 * structural. Measured on git 2.54.0.windows.1: those thirteen produce byte-identical stdout and the
 * same exit code with and without the prefix, and `git init` does not persist a `-c` value, so the
 * explicit `config` writes that follow it still decide the store's settings.
 *
 * 🔴 **WHICH git: `gitBinary()`, never the literal `"git"`.** `@novaclaw/core/git`'s `binary()` is
 * `which("git") ?? ShellBundle.resolve()?.git ?? "git"`, and its own comment says why the middle arm
 * exists — *"so snapshots/revert work on machines with no git installed"*. Git is the revert
 * substrate (per-turn snapshot trees ride it), which is why PortableGit is the one Windows bundle.
 * Spawning the bare string meant that on a Windows box with no system git this package's snapshot
 * and worktree got `ENOENT` while the provisioned bundle sat on disk — and the Shell screen named
 * that bundle as this instance's git, so the product reported a binary its own revert substrate
 * never called. Two answers to one fact; `binary()` is the one, and it is memoised per process.
 */
export const spawn = (appProcess: AppProcess.Interface, args: readonly string[], opts?: SpawnOptions) =>
  appProcess.run(
    ChildProcess.make(gitBinary(), [...CONFIG_ARGS, ...args], {
      cwd: opts?.cwd,
      env: opts?.env,
      extendEnv: true,
      // ⚠️ `"ignore"`, not the spawner's `"pipe"` default. A piped stdin that nothing writes and
      // nothing closes never reaches EOF, so a subcommand that reads it would wait forever;
      // `snapshot/` ran every one of its invocations that way. `AppProcess.run` replaces this with
      // a real stream when `opts.stdin` is set.
      stdin: "ignore",
    }),
    { maxOutputBytes: opts?.maxOutputBytes, stdin: opts?.stdin },
  )

const out = (result: { text(): string }) => result.text().trim()
const nuls = (text: string) => text.split("\0").filter(Boolean)
const fail = (err: unknown) =>
  ({
    exitCode: 1,
    text: () => "",
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
    truncated: false,
  }) satisfies Result

export type Kind = "added" | "deleted" | "modified"

export type Base = {
  readonly name: string
  readonly ref: string
}

export type Item = {
  readonly file: string
  readonly code: string
  readonly status: Kind
}

export type Stat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
  readonly binary?: boolean
}

export type Patch = {
  readonly text: string
  readonly truncated: boolean
}

export interface PatchOptions {
  readonly context?: number
  readonly maxOutputBytes?: number
}

export interface Result {
  readonly exitCode: number
  readonly text: () => string
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly truncated: boolean
}

export interface Options {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly maxOutputBytes?: number
  readonly stdin?: AppProcess.RunOptions["stdin"]
}

export interface Interface {
  readonly run: (args: string[], opts: Options) => Effect.Effect<Result>
  readonly branch: (cwd: string) => Effect.Effect<string | undefined>
  readonly prefix: (cwd: string) => Effect.Effect<string>
  readonly defaultBranch: (cwd: string) => Effect.Effect<Base | undefined>
  readonly hasHead: (cwd: string) => Effect.Effect<boolean>
  readonly mergeBase: (cwd: string, base: string, head?: string) => Effect.Effect<string | undefined>
  readonly show: (cwd: string, ref: string, file: string, prefix?: string) => Effect.Effect<string>
  readonly status: (cwd: string) => Effect.Effect<Item[]>
  readonly diff: (cwd: string, ref: string) => Effect.Effect<Item[]>
  readonly stats: (cwd: string, ref: string) => Effect.Effect<Stat[]>
  readonly patch: (cwd: string, ref: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchAll: (cwd: string, ref: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchUntracked: (cwd: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly statUntracked: (cwd: string, file: string) => Effect.Effect<Stat | undefined>
  readonly applyPatch: (cwd: string, patch: string) => Effect.Effect<Result>
}

const kind = (code: string): Kind => {
  if (code === "??") return "added"
  if (code.includes("U")) return "modified"
  if (code.includes("A") && !code.includes("D")) return "added"
  if (code.includes("D") && !code.includes("A")) return "deleted"
  return "modified"
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Git") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service

    const run = Effect.fn("Git.run")(
      function* (args: string[], opts: Options) {
        const result = yield* spawn(appProcess, args, opts)
        return {
          exitCode: result.exitCode,
          text: () => result.stdout.toString("utf8"),
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.stdoutTruncated || result.stderrTruncated,
        } satisfies Result
      },
      Effect.catch((err) => Effect.succeed(fail(err))),
    )

    const text = Effect.fn("Git.text")(function* (args: string[], opts: Options) {
      return (yield* run(args, opts)).text()
    })

    const lines = Effect.fn("Git.lines")(function* (args: string[], opts: Options) {
      return (yield* text(args, opts))
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    })

    const refs = Effect.fnUntraced(function* (cwd: string) {
      return yield* lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
    })

    const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
      const result = yield* run(["config", "init.defaultBranch"], { cwd })
      const name = out(result)
      if (!name || !list.includes(name)) return
      return { name, ref: name } satisfies Base
    })

    const primary = Effect.fnUntraced(function* (cwd: string) {
      const list = yield* lines(["remote"], { cwd })
      if (list.includes("origin")) return "origin"
      if (list.length === 1) return list[0]
      if (list.includes("upstream")) return "upstream"
      return list[0]
    })

    const branch = Effect.fn("Git.branch")(function* (cwd: string) {
      const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const prefix = Effect.fn("Git.prefix")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--show-prefix"], { cwd })
      if (result.exitCode !== 0) return ""
      return out(result)
    })

    const defaultBranch = Effect.fn("Git.defaultBranch")(function* (cwd: string) {
      const remote = yield* primary(cwd)
      if (remote) {
        const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
        if (head.exitCode === 0) {
          const ref = out(head).replace(/^refs\/remotes\//, "")
          const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
          if (name) return { name, ref } satisfies Base
        }
      }

      const list = yield* refs(cwd)
      const next = yield* configured(cwd, list)
      if (next) return next
      if (list.includes("main")) return { name: "main", ref: "main" } satisfies Base
      if (list.includes("master")) return { name: "master", ref: "master" } satisfies Base
    })

    const hasHead = Effect.fn("Git.hasHead")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
      return result.exitCode === 0
    })

    const mergeBase = Effect.fn("Git.mergeBase")(function* (cwd: string, base: string, head = "HEAD") {
      const result = yield* run(["merge-base", base, head], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const show = Effect.fn("Git.show")(function* (cwd: string, ref: string, file: string, prefix = "") {
      const target = prefix ? `${prefix}${file}` : file
      const result = yield* run(["show", `${ref}:${target}`], { cwd })
      if (result.exitCode !== 0) return ""
      if (result.stdout.includes(0)) return ""
      return result.text()
    })

    const status = Effect.fn("Git.status")(function* (cwd: string) {
      return nuls(
        yield* text(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
          cwd,
        }),
      ).flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const diff = Effect.fn("Git.diff")(function* (cwd: string, ref: string) {
      const list = nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], { cwd }),
      )
      return list.flatMap((code, idx) => {
        if (idx % 2 !== 0) return []
        const file = list[idx + 1]
        if (!code || !file) return []
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const stats = Effect.fn("Git.stats")(function* (cwd: string, ref: string) {
      return nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], { cwd }),
      ).flatMap((item) => {
        const a = item.indexOf("\t")
        const b = item.indexOf("\t", a + 1)
        if (a === -1 || b === -1) return []
        const file = item.slice(b + 1)
        if (!file) return []
        const adds = item.slice(0, a)
        const dels = item.slice(a + 1, b)
        const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
        const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
        return [
          {
            file,
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
            binary: adds === "-" || dels === "-" || undefined,
          } satisfies Stat,
        ]
      })
    })

    const patch = Effect.fn("Git.patch")(function* (cwd: string, ref: string, file: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", file],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchAll = Effect.fn("Git.patchAll")(function* (cwd: string, ref: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", "."],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchUntracked = Effect.fn("Git.patchUntracked")(function* (
      cwd: string,
      file: string,
      options?: PatchOptions,
    ) {
      const result = yield* run(
        [
          "diff",
          "--no-index",
          "--patch",
          "--no-ext-diff",
          "--no-renames",
          `--unified=${options?.context ?? 3}`,
          "--",
          "/dev/null",
          file,
        ],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const statUntracked = Effect.fn("Git.statUntracked")(function* (cwd: string, file: string) {
      const result = yield* run(["diff", "--no-index", "--numstat", "--", "/dev/null", file], {
        cwd,
        maxOutputBytes: 4096,
      })

      if (result.truncated) return
      const text = result.text()

      const parts = text.split("\t")
      if (parts.length < 2) return

      const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] || "0", 10)
      const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] || "0", 10)
      return {
        file,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
        binary: parts[0] === "-" || parts[1] === "-" || undefined,
      } satisfies Stat
    })

    const applyPatch = Effect.fn("Git.applyPatch")(function* (cwd: string, patch: string) {
      return yield* run(["apply", "-"], { cwd, stdin: patch })
    })

    return Service.of({
      run,
      branch,
      prefix,
      defaultBranch,
      hasHead,
      mergeBase,
      show,
      status,
      diff,
      stats,
      patch,
      patchAll,
      patchUntracked,
      statUntracked,
      applyPatch,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppProcess.defaultLayer))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AppProcess.node] })

export * as Git from "."
