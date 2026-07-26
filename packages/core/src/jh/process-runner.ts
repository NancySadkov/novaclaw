export * as JhProcessRunner from "./process-runner"

// jh — the bounded shell runner for the verify-gate (jh.md §6 Verifier; mirrors runQualityCheck in
// session/runner/llm.ts but with plain node:child_process, no AppProcess service — rule §0.7.1). It
// NEVER fails: a spawn error (ENOENT), a non-zero exit, or a timeout all resolve to a RunResult. stdout
// and stderr are merged and capped; on timeout the whole process tree is killed (win32 taskkill /T,
// unix process-group SIGKILL) so a lingering grandchild can't wedge the caller.

import { Effect } from "effect"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

export interface RunResult {
  readonly exitCode: number | undefined
  readonly output: string
  readonly timedOut: boolean
}

export interface Runner {
  readonly run: (input: { command: string; cwd: string; timeoutMs: number }) => Effect.Effect<RunResult>
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      child.kill()
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL") // detached → negative pid targets the process group
    } catch {
      child.kill("SIGKILL")
    }
  }
}

function runOnce(
  input: { command: string; cwd: string; timeoutMs: number },
  shellPath: string,
  maxBytes: number,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
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
      child = spawn(input.command, [], {
        cwd: input.cwd,
        shell: shellPath,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        ...(env ? { env } : {}),
      })
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
      killTree(child)
      // Safety net: if `close` doesn't arrive shortly after the kill, resolve anyway.
      giveUp = setTimeout(() => finish({ exitCode: undefined, output, timedOut: true }), 3_000)
    }, input.timeoutMs)

    child.on("error", (e) => finish({ exitCode: undefined, output: output + messageOf(e), timedOut }))
    child.on("close", (code) => finish({ exitCode: timedOut ? undefined : (code ?? undefined), output, timedOut }))
  })
}

export function shellRunner(options?: { shell?: string; maxOutputBytes?: number; env?: NodeJS.ProcessEnv }): Runner {
  const shellPath = options?.shell ?? (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")
  const maxBytes = options?.maxOutputBytes ?? 65_536
  return {
    run: (input) => Effect.promise(() => runOnce(input, shellPath, maxBytes, options?.env)),
  }
}
