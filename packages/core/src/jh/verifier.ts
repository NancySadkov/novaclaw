export * as JhVerifier from "./verifier"

// jh — the deterministic verify-gate (jh.md §5 law 4, §6 Verifier). Executes a step's Check via an
// injected Runner (compile/run/output_equals) or a probe (file_exists / artifact_present). The gate is
// ALWAYS the objective check, never the model (rule §0.7.4). Failure detail is bounded and tail-biased
// (the compiler/test error lives at the END of the output).

import { Effect } from "effect"
import type { JhStep } from "./step"
import type { JhProcessRunner } from "./process-runner"

export interface VerifyResult {
  readonly ok: boolean
  readonly detail: string // ≤ DETAIL_CAP chars, tail-biased
}

export const DEFAULT_TIMEOUT_MS = 60_000
const DETAIL_CAP = 2_000

const normalizeCRLF = (s: string): string => s.replace(/\r\n/g, "\n")
const tail = (s: string, max = DETAIL_CAP): string => (s.length <= max ? s : s.slice(s.length - max))
const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max) + "…")
// C9: a bare "timed out after Nms" manufactures a fake opaque rut (a hanging program prints nothing, so
// the analyze stage can't localize it) — name the likely cause and the fix in the detail itself.
const timeoutDetail = (ms: number): string =>
  `timed out after ${ms}ms and was KILLED — the command did not terminate. If it RUNS a program, that program most likely has an INFINITE LOOP (or reads input it never gets): add an iteration BOUND to every loop, print progress, recompile, and re-run.`

export function verify(input: {
  readonly check: JhStep.Check
  readonly cwd: string
  readonly runner: JhProcessRunner.Runner
  readonly fileExists: (relPath: string) => boolean
  readonly producedPresent: boolean
  /** C9: fallback timeout when the check itself sets none — callers on compute tasks pass a SHORT one
   *  (a correct program finishes in seconds; a 60 s wait per hung run is pure wall loss, run57). */
  readonly defaultTimeoutMs?: number
}): Effect.Effect<VerifyResult> {
  const check = input.check
  switch (check.type) {
    case "artifact_present":
      return Effect.succeed(
        input.producedPresent ? { ok: true, detail: "" } : { ok: false, detail: "declared produces missing or empty" },
      )
    case "file_exists":
      return Effect.succeed(
        input.fileExists(check.path) ? { ok: true, detail: "" } : { ok: false, detail: `file not found: ${check.path}` },
      )
    case "compile":
    case "run": {
      const timeoutMs = check.timeoutMs ?? input.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
      return input.runner.run({ command: check.command, cwd: input.cwd, timeoutMs }).pipe(
        Effect.map((r): VerifyResult => {
          if (r.timedOut) return { ok: false, detail: timeoutDetail(timeoutMs) }
          if (r.exitCode !== 0) return { ok: false, detail: tail(r.output) }
          if (check.type === "run" && check.expect !== undefined && !r.output.includes(check.expect)) {
            return { ok: false, detail: tail(`expected output to contain "${check.expect}"; got: ${r.output}`) }
          }
          return { ok: true, detail: "" }
        }),
      )
    }
    case "output_equals": {
      const timeoutMs = check.timeoutMs ?? input.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
      return input.runner.run({ command: check.command, cwd: input.cwd, timeoutMs }).pipe(
        Effect.map((r): VerifyResult => {
          if (r.timedOut) return { ok: false, detail: timeoutDetail(timeoutMs) }
          const got = normalizeCRLF(r.output).trim()
          const want = normalizeCRLF(check.expected).trim()
          return got === want
            ? { ok: true, detail: "" }
            : { ok: false, detail: `expected ${clip(want, 200)}, got ${clip(got, 200)}` }
        }),
      )
    }
  }
}
