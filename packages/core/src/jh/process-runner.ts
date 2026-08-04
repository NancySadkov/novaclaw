export * as JhProcessRunner from "./process-runner"

// jh — the bounded shell runner for the verify-gate (jh.md §6 Verifier; mirrors runQualityCheck in
// session/runner/llm.ts but with plain node:child_process, no AppProcess service — rule §0.7.1). It
// NEVER fails: a spawn error (ENOENT), a non-zero exit, or a timeout all resolve to a RunResult. stdout
// and stderr are merged and capped; on timeout the whole process tree is killed through the ONE
// tree-kill (`../util/kill-tree`, re-exported as `Shell.killTree`) so a lingering grandchild can't
// wedge the caller — or accumulate into the orphan pile that hard-crashed this box on 2026-07-20
// (AGENTS.md → Known pitfalls #8). ⚠️ This file used to hand-roll that kill: an UNAWAITED `taskkill`
// on win32 and a straight-to-SIGKILL group signal on POSIX, with no ppid snapshot and no grace.
//
// ⚠️ It decides NOTHING about containment, shells, or environments. v0.2.0 ruling 6 puts all of that
// in ONE module (`src/host-exec.ts`), and §0.7.2 (imports.test.ts) forbids importing it from here —
// jh must stay off the session/tool/config trees. So the policy arrives as plain data: the caller
// hands `plannedRunner` a `plan` callback (in practice `HostExec.spawnPlan`, from
// session/runner/strict.ts) and this file executes exactly what it is given, including a refusal.
// The two `SpawnPlan` declarations are pinned structurally at that call site — see host-exec.ts.

import { Effect } from "effect"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { killTree } from "../util/kill-tree"

export interface RunResult {
  readonly exitCode: number | undefined
  readonly output: string
  readonly timedOut: boolean
}

export interface Runner {
  readonly run: (input: { command: string; cwd: string; timeoutMs: number }) => Effect.Effect<RunResult>
}

/** How to start one command — the host-execution gate's plan, as plain data (host-exec.ts). */
export interface SpawnPlan {
  /** The gate refused this command: NO process is started and this text is the whole output. */
  readonly denied?: string
  /** Exec this file with this argv (a confined bwrap argv, or `<runtime> -e <program>`). */
  readonly file?: string
  readonly args?: readonly string[]
  /** …or run the command string through this shell binary (the raw path — the runtime's own shell
   *  handling, which is the only thing that gets `cmd.exe /d /s /c` right). */
  readonly shell?: string
  readonly env?: Record<string, string>
  /** `false` REPLACES the parent environment (no inheritance); `true` merges over it. */
  readonly inherit?: boolean
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** True once the child is known dead, so a reused pid is never signalled. */
const hasExited = (child: ChildProcess) => () => child.exitCode !== null || child.signalCode !== null

/** The environment option for a plan: absent (inherit untouched), merged, or REPLACING. */
function envOption(plan: SpawnPlan): { env?: NodeJS.ProcessEnv } {
  if (plan.inherit === false) return { env: plan.env ?? {} }
  if (plan.env === undefined) return {}
  return { env: { ...process.env, ...plan.env } }
}

function runOnce(
  input: { command: string; cwd: string; timeoutMs: number },
  plan: SpawnPlan,
  maxBytes: number,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    // A refusal is an OBSERVATION, not a crash: the model reads the routing text and picks another
    // way (AgentJail.denyMessage). Nothing is spawned, and nothing pretends a command ran.
    if (plan.denied !== undefined) {
      resolve({ exitCode: undefined, output: plan.denied, timedOut: false })
      return
    }
    let output = ""
    let capped = false
    let timedOut = false
    let done = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let giveUp: ReturnType<typeof setTimeout> | undefined

    const finish = (r: RunResult) => {
      if (done) return
      done = true
      if (killTimer) clearTimeout(killTimer)
      if (giveUp) clearTimeout(giveUp)
      resolve(r)
    }

    let child: ChildProcess
    try {
      const base = {
        cwd: input.cwd,
        stdio: ["ignore", "pipe", "pipe"] as Array<"ignore" | "pipe">,
        detached: process.platform !== "win32",
        ...envOption(plan),
      }
      // A confined command execs the sandbox binary directly — the shell is an argv element inside
      // it, so the `shell` spawn option must NOT be set on this path.
      child =
        plan.file !== undefined
          ? spawn(plan.file, [...(plan.args ?? [])], base)
          : spawn(input.command, [], { ...base, shell: plan.shell ?? defaultShell() })
    } catch (e) {
      finish({ exitCode: undefined, output: messageOf(e), timedOut: false })
      return
    }

    const append = (buf: Buffer) => {
      if (capped) return
      const s = buf.toString("utf8")
      if (output.length + s.length > maxBytes) {
        output += s.slice(0, Math.max(0, maxBytes - output.length)) + "…[truncated]"
        capped = true
      } else {
        output += s
      }
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    killTimer = setTimeout(() => {
      timedOut = true
      // Deliberately not awaited: `close` is what resolves this promise, and killTree never rejects.
      // Its POSIX leg costs one SIGKILL_TIMEOUT_MS (200 ms) grace window, well inside the net below.
      void killTree(child, { exited: hasExited(child) })
      // Safety net: if `close` doesn't arrive shortly after the kill, resolve anyway.
      giveUp = setTimeout(() => finish({ exitCode: undefined, output, timedOut: true }), 3_000)
    }, input.timeoutMs)

    child.on("error", (e) => finish({ exitCode: undefined, output: output + messageOf(e), timedOut }))
    child.on("close", (code) => finish({ exitCode: timedOut ? undefined : (code ?? undefined), output, timedOut }))
  })
}

const defaultShell = (): string => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

/**
 * The runner every SESSION-side caller uses: each command is planned by the host-execution gate
 * (`HostExec.spawnPlan`) and this runner only executes the plan.
 */
export function plannedRunner(options: {
  readonly plan: (input: { readonly command: string; readonly cwd: string }) => SpawnPlan
  readonly maxOutputBytes?: number
}): Runner {
  const maxBytes = options.maxOutputBytes ?? 65_536
  return {
    run: (input) =>
      Effect.promise(() => runOnce(input, options.plan({ command: input.command, cwd: input.cwd }), maxBytes)),
  }
}

/**
 * ⚠️ UNGATED — a plain shell runner with no jail decision and no environment curation. It exists for
 * the engine's own unit tests and for non-session callers; a session path that used it would be
 * exactly the second call site ruling 6 exists to prevent, and `test/tool-path-classification.test.ts`
 * fails if one appears under `src/session/`.
 */
export function shellRunner(options?: { shell?: string; maxOutputBytes?: number; env?: NodeJS.ProcessEnv }): Runner {
  const shell = options?.shell ?? defaultShell()
  const env = options?.env
  return plannedRunner({
    plan: () => ({ shell, ...(env ? { env: env as Record<string, string>, inherit: false } : {}) }),
    ...(options?.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  })
}
