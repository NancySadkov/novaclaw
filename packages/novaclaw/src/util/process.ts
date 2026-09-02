import { type ChildProcess } from "child_process"
import type { Stream } from "node:stream"
import launch from "cross-spawn"
import { buffer } from "node:stream/consumers"
import { Shell } from "@novaclaw/core/shell"
import { errorMessage } from "./error"

export type Stdio = "inherit" | "pipe" | "ignore" | number | Stream
export type Shell = boolean | string

export interface Options {
  cwd?: string
  env?: NodeJS.ProcessEnv | null
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  shell?: Shell
  abort?: AbortSignal
  // ⚠️ There is deliberately NO `kill` signal and NO `timeout` grace here any more. They configured a
  // SECOND kill policy on the same object — a bare `proc.kill` to the ROOT — living fifty lines above
  // the one that reaps the tree, and a knob that selects the orphaning kill is the defect, not the
  // caller who reaches for it. `abort` and {@link stop} both go through `Shell.killTree`, which owns
  // the signal sequence and the grace window for every platform.
}

export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
  nothrow?: boolean
}

export interface Result {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export interface TextResult extends Result {
  text: string
}

export class RunFailedError extends Error {
  readonly cmd: string[]
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer

  constructor(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
    const text = stderr.toString().trim()
    super(
      text
        ? `Command failed with code ${code}: ${cmd.join(" ")}\n${text}`
        : `Command failed with code ${code}: ${cmd.join(" ")}`,
    )
    this.name = "ProcessRunFailedError"
    this.cmd = [...cmd]
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export type Child = ChildProcess & { exited: Promise<number> }

export function spawn(cmd: string[], opts: Options = {}): Child {
  if (cmd.length === 0) throw new Error("Command is required")
  opts.abort?.throwIfAborted()

  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
  })

  let closed = false
  const dead = () => proc.exitCode !== null || proc.signalCode !== null

  /**
   * 🔴 **Aborting goes through the ONE tree-kill, exactly as {@link stop} does.**
   *
   * This used to be `proc.kill(...)` plus a `setTimeout` SIGKILL — a signal to the ROOT only, which
   * is the precise thing `stop`'s own comment fifty lines below forbids: on Windows a non-tree kill
   * leaves every grandchild running, and on POSIX SIGKILL to the root guarantees the tree is
   * orphaned rather than reaped. So `Process.spawn`/`Process.run` held two kill policies for one
   * object, and the weaker one was on the path a timeout or a cancelled request takes.
   */
  const abort = () => {
    if (closed || dead()) return
    closed = true
    // `killTree` never throws and never rejects, so this needs no catch arm.
    void Shell.killTree(proc, { exited: dead })
  }

  const exited = new Promise<number>((resolve, reject) => {
    const done = () => {
      opts.abort?.removeEventListener("abort", abort)
    }

    proc.once("exit", (code, signal) => {
      done()
      resolve(code ?? (signal ? 1 : 0))
    })

    proc.once("error", (error) => {
      done()
      reject(error)
    })
  })
  void exited.catch(() => undefined)

  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }

  const child = proc as Child
  child.exited = exited
  return child
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
  const proc = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    shell: opts.shell,
    abort: opts.abort,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.stdout || !proc.stderr) throw new Error("Process output not available")

  const out = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
    .then(([code, stdout, stderr]) => ({
      code,
      stdout,
      stderr,
    }))
    .catch((err: unknown) => {
      if (!opts.nothrow) throw err
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(errorMessage(err)),
      }
    })
  if (out.code === 0 || opts.nothrow) return out
  throw new RunFailedError(cmd, out.code, out.stdout, out.stderr)
}

/**
 * Stop a child and everything it spawned, through the ONE tree-kill (`Shell.killTree`).
 *
 * ⚠️ This used to be hand-rolled, and its POSIX branch was a bare `proc.kill()` — a plain SIGTERM to
 * the ROOT, which orphans every grandchild. Orphans on this box accumulate at GBs each and once
 * hard-crashed the machine (AGENTS.md → Known pitfalls #8).
 *
 * There is no longer a sanctioned duplicate. This used to name `packages/sdk/js/src/process.ts` as
 * one, on the grounds that the SDK carried a runtime dependency on purpose — a claim that contradicted
 * todo.md's standing decision (*"`@novaclaw/sdk` carries ZERO runtime dependencies"*) and lost to it on
 * 2026-07-29: the SDK's `v2/server.ts` was deleted, so the SDK spawns nothing and its copy went with
 * it. The live ledger is `packages/core/test/kill-tree-ledger.test.ts`, and it can only shrink.
 */
export async function stop(proc: ChildProcess) {
  await Shell.killTree(proc, { exited: () => proc.exitCode !== null || proc.signalCode !== null })
}

export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
  const out = await run(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  }
}

export async function lines(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
  return (await text(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
}

export * as Process from "./process"
