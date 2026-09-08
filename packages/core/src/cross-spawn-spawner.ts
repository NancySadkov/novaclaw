import type * as Arr from "effect/Array"
import { NodeFileSystem, NodeSink, NodeStream } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
} from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
import { PassThrough } from "node:stream"
import launch from "cross-spawn"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem, path } from "./effect/app-node-platform"
// THE one tree-kill (re-exported as `Shell.killTree`). The leaf spelling is used here rather than
// `./shell` so this spawner keeps its current, minimal reach.
import { killTree, killTreeSync } from "./util/kill-tree"

const toError = (err: unknown): Error => (err instanceof globalThis.Error ? err : new globalThis.Error(String(err)))

const toTag = (err: NodeJS.ErrnoException): PlatformError.SystemErrorTag => {
  switch (err.code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
      return "BadResource"
    case "ENOTDIR":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    case "ELOOP":
      return "BadResource"
    default:
      return "Unknown"
  }
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []

  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }

  walk(command)
  if (commands.length === 0) throw new Error("flatten produced empty commands array")
  const [head, ...tail] = commands
  return {
    commands: [head, ...tail] as Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand>,
    opts,
  }
}

const toPlatformError = (
  method: string,
  err: NodeJS.ErrnoException,
  command: ChildProcess.Command,
): PlatformError.PlatformError => {
  const cmd = flatten(command)
    .commands.map((x) => `${x.command} ${x.args.join(" ")}`)
    .join(" | ")
  return PlatformError.systemError({
    _tag: toTag(err),
    module: "ChildProcess",
    method,
    pathOrDescriptor: cmd,
    syscall: err.syscall,
    cause: err,
  })
}

type ExitSignal = Deferred.Deferred<readonly [code: number | null, signal: NodeJS.Signals | null]>

/**
 * ⚠️ **Two signals, because `'close'` is not a promise that the process is gone — it is a promise
 * that the PIPES are gone, and those are different facts on Windows.**
 *
 * Node fires `'exit'` when the child terminates and `'close'` only once every stdio stream has also
 * closed. A stream stays open while ANYONE holds the write end — including a grandchild that
 * inherited it — so a command whose last act is to leave a background process behind (`npm run dev`,
 * a watcher, a spawned server) fires `'exit'` immediately and `'close'` when that grandchild dies,
 * which for a daemon is never. Measured 2026-07-31 with a plain node repro: `'exit'` at **70 ms**,
 * `'close'` at **5107 ms**, delayed by exactly the grandchild's lifetime. The same shape also shows
 * up as a RACE under load with no grandchild at all: a killed child's overlapped pipes can be left
 * un-closed, giving `'exit'` and no `'close'` at all (observed on a 5-way-concurrent suite run; the
 * child was dead within 360 ms and `'close'` had still not arrived 14 s later).
 *
 * That is why the `'close'` deferred cannot be what TEARDOWN waits on. The `acquireRelease` release
 * below, and `handle.kill`, both used to `Deferred.await(signal)` with **no bound at all** — so
 * closing a scope around such a command blocked forever, which surfaced as `BashJobs.stop` (the
 * agent's "stop this job" control) never returning and the session's turn wedging behind it.
 *
 * So teardown awaits {@link exited} — "the process is gone", the fact it actually needs — while
 * `exitCode`/`isRunning` keep awaiting `signal` so CONSUMERS still see fully drained output before
 * an exit code. Do not collapse these two back into one deferred: each is load-bearing for a
 * different caller, and the pinning test is `core/test/spawner-teardown-bounded.test.ts`.
 */
type ExitedSignal = Deferred.Deferred<readonly [code: number | null, signal: NodeJS.Signals | null]>

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const cwd = Effect.fnUntraced(function* (opts: ChildProcess.CommandOptions) {
    if (Predicate.isUndefined(opts.cwd)) return undefined
    yield* fs.access(opts.cwd)
    return path.resolve(opts.cwd)
  })

  const env = (opts: ChildProcess.CommandOptions) =>
    opts.extendEnv ? { ...globalThis.process.env, ...opts.env } : opts.env

  const input = (x: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(x) ? "pipe" : x

  const output = (x: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(x) ? "pipe" : x

  const stdin = (opts: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const cfg: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(opts.stdin)) return cfg
    if (typeof opts.stdin === "string") return { ...cfg, stream: opts.stdin }
    if (Stream.isStream(opts.stdin)) return { ...cfg, stream: opts.stdin }
    return {
      stream: opts.stdin.stream,
      encoding: opts.stdin.encoding ?? cfg.encoding,
      endOnDone: opts.stdin.endOnDone ?? cfg.endOnDone,
    }
  }

  const stdio = (opts: ChildProcess.CommandOptions, key: "stdout" | "stderr"): ChildProcess.StdoutConfig => {
    const cfg = opts[key]
    if (Predicate.isUndefined(cfg)) return { stream: "pipe" }
    if (typeof cfg === "string") return { stream: cfg }
    if (Sink.isSink(cfg)) return { stream: cfg }
    return { stream: cfg.stream }
  }

  const fds = (opts: ChildProcess.CommandOptions) => {
    if (Predicate.isUndefined(opts.additionalFds)) return []
    return Object.entries(opts.additionalFds)
      .flatMap(([name, config]) => {
        const fd = ChildProcess.parseFdName(name)
        return Predicate.isUndefined(fd) ? [] : [{ fd, config }]
      })
      .toSorted((a, b) => a.fd - b.fd)
  }

  const stdios = (
    sin: ChildProcess.StdinConfig,
    sout: ChildProcess.StdoutConfig,
    serr: ChildProcess.StderrConfig,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ): NodeChildProcess.StdioOptions => {
    const pipe = (x: NodeChildProcess.IOType | undefined) =>
      process.platform === "win32" && x === "pipe" ? "overlapped" : x
    const arr: Array<NodeChildProcess.IOType | undefined> = [
      pipe(input(sin.stream)),
      pipe(output(sout.stream)),
      pipe(output(serr.stream)),
    ]
    if (extra.length === 0) return arr as NodeChildProcess.StdioOptions
    const max = extra.reduce((acc, x) => Math.max(acc, x.fd), 2)
    for (let i = 3; i <= max; i++) arr[i] = "ignore"
    for (const x of extra) arr[x.fd] = pipe("pipe")
    return arr as NodeChildProcess.StdioOptions
  }

  const setupFds = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ) {
    if (extra.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }
    }

    const ins = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outs = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const x of extra) {
      const node = proc.stdio[x.fd]
      switch (x.config.type) {
        case "input": {
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (node && "write" in node) {
            sink = NodeSink.fromWritable({
              evaluate: () => node,
              onError: (err) => toPlatformError(`fromWritable(fd${x.fd})`, toError(err), command),
              endOnDone: true,
            })
          }
          if (x.config.stream) yield* Effect.forkScoped(Stream.run(x.config.stream, sink))
          ins.set(x.fd, sink)
          break
        }
        case "output": {
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (node && "read" in node) {
            const tap = new PassThrough()
            node.on("error", (err) => tap.destroy(toError(err)))
            node.pipe(tap)
            stream = NodeStream.fromReadable({
              evaluate: () => tap,
              onError: (err) => toPlatformError(`fromReadable(fd${x.fd})`, toError(err), command),
            })
          }
          if (x.config.sink) stream = Stream.transduce(stream, x.config.sink)
          outs.set(x.fd, stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => ins.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outs.get(fd) ?? Stream.empty,
    }
  })

  const setupStdin = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    cfg: ChildProcess.StdinConfig,
  ) =>
    Effect.suspend(() => {
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(proc.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => proc.stdin!,
          onError: (err) => toPlatformError("fromWritable(stdin)", toError(err), command),
          endOnDone: cfg.endOnDone,
          encoding: cfg.encoding,
        })
      }
      if (Stream.isStream(cfg.stream)) return Effect.as(Effect.forkScoped(Stream.run(cfg.stream, sink)), sink)
      return Effect.succeed(sink)
    })

  const setupOutput = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    out: ChildProcess.StdoutConfig,
    err: ChildProcess.StderrConfig,
  ) => {
    let stdout = proc.stdout
      ? NodeStream.fromReadable({
          evaluate: () => proc.stdout!,
          onError: (cause) => toPlatformError("fromReadable(stdout)", toError(cause), command),
        })
      : Stream.empty
    let stderr = proc.stderr
      ? NodeStream.fromReadable({
          evaluate: () => proc.stderr!,
          onError: (cause) => toPlatformError("fromReadable(stderr)", toError(cause), command),
        })
      : Stream.empty

    if (Sink.isSink(out.stream)) stdout = Stream.transduce(stdout, out.stream)
    if (Sink.isSink(err.stream)) stderr = Stream.transduce(stderr, err.stream)

    return { stdout, stderr, all: Stream.merge(stdout, stderr) }
  }

  const spawn = (command: ChildProcess.StandardCommand, opts: NodeChildProcess.SpawnOptions) =>
    Effect.callback<readonly [NodeChildProcess.ChildProcess, ExitSignal, ExitedSignal], PlatformError.PlatformError>(
      (resume) => {
        const signal = Deferred.makeUnsafe<readonly [code: number | null, signal: NodeJS.Signals | null]>()
        // See ExitedSignal above: settled by whichever of 'exit'/'close' lands FIRST. 'close' is a real
        // fallback rather than dead weight — a child that dies before it ever runs can close without
        // emitting 'exit', and teardown must not wait forever for that one either.
        const exited = Deferred.makeUnsafe<readonly [code: number | null, signal: NodeJS.Signals | null]>()
        const proc = launch(command.command, command.args, opts)
        let end = false
        let exit: readonly [code: number | null, signal: NodeJS.Signals | null] | undefined
        proc.on("error", (err) => {
          resume(Effect.fail(toPlatformError("spawn", err, command)))
        })
        proc.on("exit", (...args) => {
          exit = args
          Deferred.doneUnsafe(exited, Exit.succeed(args))
        })
        proc.on("close", (...args) => {
          Deferred.doneUnsafe(exited, Exit.succeed(exit ?? args))
          if (end) return
          end = true
          Deferred.doneUnsafe(signal, Exit.succeed(exit ?? args))
        })
        proc.on("spawn", () => {
          resume(Effect.succeed([proc, signal, exited]))
        })
        return Effect.sync(() => {
          // Interrupted before `spawn` fired, so `acquireRelease` never acquired and this is the ONLY
          // teardown this child will get — it must reach the whole tree, not just the root. A sync
          // context cannot await, hence the sync twin (no SIGTERM grace on POSIX; see kill-tree.ts).
          killTreeSync(proc)
        })
      },
    )

  /**
   * Terminate the child AND everything it spawned, through the ONE tree-kill (`util/kill-tree.ts`).
   *
   * ⚠️ What this replaced, because both halves were real holes (v0.2.0-prep Wave 1, unit C2):
   *  · win32 interpolated the pid into an `exec` SHELL STRING (`taskkill /pid ${proc.pid} /T /F`).
   *    The pid is a number so it was not exploitable — the SHAPE was the defect, and a shell hop is
   *    also one more process to leak.
   *  · POSIX signalled the process GROUP and nothing else: no ppid snapshot (so a descendant that
   *    detached into its own group survived) and no SIGTERM→grace→SIGKILL escalation.
   *
   * `signal` is accepted to keep the `timeout(...)` helper's shape and is deliberately IGNORED:
   * killTree owns the escalation itself (SIGTERM, 200 ms, SIGKILL) and nothing in this repo passes a
   * non-terminal `killSignal` (grepped 2026-07-28 — every call site is the `SIGTERM` default plus
   * `forceKillAfter`). If a caller ever needs SIGINT/SIGHUP delivery, that is a NEW option on
   * killTree, not a second kill here.
   *
   * The declared `PlatformError` channel is kept so the callers' `Effect.catch(…, killOne)` fallback
   * still typechecks; killTree never fails, so that fallback is now belt-and-braces.
   */
  const killGroup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    // NO `exited` guard: the finalizer's `done` branch calls this precisely BECAUSE the child has
    // already exited, to reap the children it left behind. Short-circuiting on exit would silently
    // turn that path into a no-op.
    Effect.promise(() => killTree(proc))

  const killOne = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) =>
    Effect.suspend(() => {
      if (proc.kill(signal)) return Effect.void
      return Effect.fail(toPlatformError("kill", new Error("Failed to kill child process"), command))
    })

  const timeout =
    (
      proc: NodeChildProcess.ChildProcess,
      command: ChildProcess.StandardCommand,
      opts: ChildProcess.KillOptions | undefined,
    ) =>
    <A, E, R>(
      f: (
        command: ChildProcess.StandardCommand,
        proc: NodeChildProcess.ChildProcess,
        signal: NodeJS.Signals,
      ) => Effect.Effect<A, E, R>,
    ) => {
      const signal = opts?.killSignal ?? "SIGTERM"
      if (Predicate.isUndefined(opts?.forceKillAfter)) return f(command, proc, signal)
      return Effect.timeoutOrElse(f(command, proc, signal), {
        duration: opts.forceKillAfter,
        orElse: () => f(command, proc, "SIGKILL"),
      })
    }

  const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
    const opt = from ?? "stdout"
    switch (opt) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        const fd = ChildProcess.parseFdName(opt)
        return Predicate.isNotUndefined(fd) ? handle.getOutputFd(fd) : handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> = Effect.fnUntraced(
    function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const sin = stdin(command.options)
          const sout = stdio(command.options, "stdout")
          const serr = stdio(command.options, "stderr")
          const extra = fds(command.options)
          const dir = yield* cwd(command.options)

          const [proc, signal, exited] = yield* Effect.acquireRelease(
            spawn(command, {
              cwd: dir,
              env: env(command.options),
              stdio: stdios(sin, sout, serr, extra),
              detached: command.options.detached ?? process.platform !== "win32",
              shell: command.options.shell,
              windowsHide: process.platform === "win32",
            }),
            // ⚠️ Every WAIT in here is on `exited`, never on `signal` — see ExitedSignal above. This
            // finalizer's job is "the child is gone before the scope releases"; waiting on the PIPES
            // instead made it unbounded, and a scope that cannot close is a hang with no timeout
            // anywhere above it to rescue it.
            //
            // ⚠️ The BRANCH, though, still asks `signal`, and that is deliberate: the fast path below
            // skips the kill entirely, and it is only safe to skip when the pipes are closed too. A
            // child that exited while a grandchild still holds its stdout is exactly the case that
            // MUST fall through to `killGroup` — on POSIX that group signal is the only thing that
            // ever reaps the grandchild. Keying this on `exited` reads as a tidy-up and quietly turns
            // that reap off (AGENTS.md → Known pitfalls #8).
            Effect.fnUntraced(function* ([proc, signal, exited]) {
              const done = yield* Deferred.isDone(signal)
              const kill = timeout(proc, command, command.options)
              if (done) {
                const [code] = yield* Deferred.await(signal)
                if (process.platform === "win32") return yield* Effect.void
                if (code !== 0 && Predicate.isNotNull(code)) return yield* Effect.ignore(kill(killGroup))
                return yield* Effect.void
              }
              const send = (s: NodeJS.Signals) =>
                Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              const sig = command.options.killSignal ?? "SIGTERM"
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(exited)), Effect.asVoid)
              const escalated = command.options.forceKillAfter
                ? Effect.timeoutOrElse(attempt, {
                    duration: command.options.forceKillAfter,
                    orElse: () => send("SIGKILL").pipe(Effect.andThen(Deferred.await(exited)), Effect.asVoid),
                  })
                : attempt
              return yield* Effect.ignore(escalated)
            }),
          )

          const fd = yield* setupFds(command, proc, extra)
          const out = setupOutput(command, proc, sout, serr)
          let ref = true
          return makeHandle({
            pid: ProcessId(proc.pid!),
            stdin: yield* setupStdin(command, proc, sin),
            stdout: out.stdout,
            stderr: out.stderr,
            all: out.all,
            getInputFd: fd.getInputFd,
            getOutputFd: fd.getOutputFd,
            isRunning: Effect.map(Deferred.isDone(signal), (done) => !done),
            exitCode: Effect.flatMap(Deferred.await(signal), ([code, signal]) => {
              if (Predicate.isNotNull(code)) return Effect.succeed(ExitCode(code))
              return Effect.fail(
                toPlatformError(
                  "exitCode",
                  new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                  command,
                ),
              )
            }),
            // Same rule as the release finalizer: `kill` resolves when the PROCESS is gone, not when
            // its pipes are. A caller that also wants drained output awaits `exitCode` after this.
            kill: (opts?: ChildProcess.KillOptions) => {
              const sig = opts?.killSignal ?? "SIGTERM"
              const send = (s: NodeJS.Signals) =>
                Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(exited)), Effect.asVoid)
              if (!opts?.forceKillAfter) return attempt
              return Effect.timeoutOrElse(attempt, {
                duration: opts.forceKillAfter,
                orElse: () => send("SIGKILL").pipe(Effect.andThen(Deferred.await(exited)), Effect.asVoid),
              })
            },
            unref: Effect.sync(() => {
              if (ref) {
                proc.unref()
                ref = false
              }
              return Effect.sync(() => {
                if (!ref) {
                  proc.ref()
                  ref = true
                }
              })
            }),
          })
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]
            const opts = flat.opts[i] ?? {}
            const sin = stdin(next.options)
            const stream = Stream.unwrap(Effect.map(handle, (x) => source(x, opts.from)))
            const to = opts.to ?? "stdin"
            if (to === "stdin") {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            const fd = ChildProcess.parseFdName(to)
            if (Predicate.isUndefined(fd)) {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            handle = spawnCommand(
              ChildProcess.make(next.command, next.args, {
                ...next.options,
                additionalFds: {
                  ...next.options.additionalFds,
                  [ChildProcess.fdName(fd) as `fd${number}`]: { type: "input", stream },
                },
              }),
            )
          }
          return yield* handle
        }
      }
    },
  )

  return makeSpawner(spawnCommand)
})

export const layer: Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  ChildProcessSpawner,
  make,
)

export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer))
export const node = makeGlobalNode({ service: ChildProcessSpawner, layer, deps: [filesystem, path] })

export * as CrossSpawnSpawner from "./cross-spawn-spawner"
