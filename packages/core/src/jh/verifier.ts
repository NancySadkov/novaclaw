export * as JhVerifier from "./verifier"

// jh — the deterministic verify-gate (jh.md §5 law 4, §6 Verifier). Executes a step's Check via an
// injected Runner (compile/run/output_equals) or a probe (file_exists / artifact_present). The gate is
// ALWAYS the objective check, never the model (rule §0.7.4). Failure detail is bounded and tail-biased
// (the compiler/test error lives at the END of the output).

import { Effect } from "effect"
import type { Presence } from "../presence"
import type { JhStep } from "./step"
import type { JhProcessRunner } from "./process-runner"

export interface VerifyResult {
  readonly ok: boolean
  readonly detail: string // ≤ DETAIL_CAP chars, tail-biased
  /**
   * **The check could not be PERFORMED** — as distinct from performed and failed.
   *
   * 🔴 `ok: false` says *the subject did not meet the check*; this says *our instrument failed, so we
   * learned nothing about the subject*. Audited 2026-08-19: `file_exists` was built on `fs.existsSync`,
   * which answers `false` for `EACCES`, `EPERM`, `ELOOP` and `EIO` exactly as it does for `ENOENT`, and
   * the gate then wrote **“file not found: <path>”** into the transcript the model reads back. On a
   * locked file that is a fabricated observation handed to a model as ground truth — the one thing a
   * deterministic gate exists to never do.
   *
   * ⚠️ **`ok` stays `false` and that is deliberate.** The gate certifies; it may not certify what it
   * could not check, so the step still does not pass. What changes is the DETAIL, which is the part
   * that was making a claim the evidence did not support. A consumer that wants to treat the two
   * differently — retry rather than escalate, say — now has the field to do it on; nothing is forced
   * to, so this cannot silently turn a real failure into a pass.
   */
  readonly inconclusive?: boolean
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
  /**
   * The three-answer probe, when the caller has one. Preferred over {@link fileExists} whenever it is
   * supplied, and every production caller supplies it (`session/runner/strict.ts`).
   *
   * ⚠️ Kept OPTIONAL on purpose rather than widening `fileExists`: the boolean probe has ~20 suppliers
   * in this package's own suites, all of them in-memory worlds where "could not read" cannot happen, so
   * widening the required contract would churn twenty files to say nothing new. A caller that can only
   * answer two ways keeps answering two ways; a caller that touches a real disk must answer three.
   */
  readonly filePresence?: (relPath: string) => Presence.Answer
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
    case "file_exists": {
      const answer: Presence.Answer =
        input.filePresence?.(check.path) ?? (input.fileExists(check.path) ? "present" : "absent")
      if (answer === "present") return Effect.succeed({ ok: true, detail: "" })
      // 🔴 The two ways of not seeing a file, kept apart. `absent` is an observation about the work;
      // `unreadable` is an observation about us, and saying "file not found" on it would put a fact the
      // gate never established into the transcript the model reasons from next turn.
      if (answer === "absent") return Effect.succeed({ ok: false, detail: `file not found: ${check.path}` })
      return Effect.succeed({
        ok: false,
        inconclusive: true,
        detail:
          `could not check ${check.path} — the check itself failed (the path could not be read: permissions, ` +
          `a symlink loop, or a drive that is not answering). This says NOTHING about whether the file is ` +
          `there. Fix the read, or write the file to a path you can read, then re-run this step.`,
      })
    }
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
