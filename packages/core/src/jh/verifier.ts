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
  /**
   * **What the program printed when THIS gate ran it** — present only for the two checks that execute
   * the workspace's own product (`run`, `output_equals`) and only when the process actually terminated.
   *
   * 🔴 The gate re-runs the program. Before this field it swallowed the result and handed back a verdict,
   * so every engine-side consumer of "the most recent program output" had to be wired to the OTHER path —
   * the model's own `run` action — one at a time. `staleness.recordAction` was wired that way and then
   * patched (its comment names the gap: it "previously saw only ACTION runs + rebuilds, never verify-check
   * runs"); the completion oracle and the forced-analyze instrumentation gate were not, so a verify that
   * re-ran the program judged the PREVIOUS run's stdout. Returning the observation instead of discarding it
   * is what stops the next consumer from being missed the same way.
   *
   * ⚠️ Absent on a TIMEOUT: a killed process's output is truncated wherever the kill landed, so it is not
   * "what the program printed" — the timeout detail says so instead.
   */
  readonly runOutput?: string
}

/**
 * What we know about a step's DECLARED products — three answers, because *"every one of them is there"*
 * and *"there were none to be there"* are not the same sentence, and a boolean cannot tell them apart.
 *
 * 🔴 This used to be `producedPresent: boolean`, computed by the engine as `produces.every(present)`.
 * `[].every(…)` is `true`, so a step that declared NO products passed `artifact_present` unconditionally —
 * and `artifact_present` is exactly the check the engine substitutes when the model omits one, i.e. the
 * default gate for the LEAST-specified step in a run. The same empty-quantifier trap is guarded explicitly
 * at the codebase's other two evidence-`every` sites (`tree.ts`'s `allChildrenCommitted`, `drive.ts`'s
 * goal-complete arm); the boolean here was the one place it could not be.
 */
export type Produced = "none_declared" | "present" | "missing"

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
  readonly produced: Produced
  /** C9: fallback timeout when the check itself sets none — callers on compute tasks pass a SHORT one
   *  (a correct program finishes in seconds; a 60 s wait per hung run is pure wall loss, run57). */
  readonly defaultTimeoutMs?: number
}): Effect.Effect<VerifyResult> {
  const check = input.check
  switch (check.type) {
    case "artifact_present": {
      if (input.produced === "present") return Effect.succeed({ ok: true, detail: "" })
      if (input.produced === "missing")
        return Effect.succeed({ ok: false, detail: "declared produces missing or empty" })
      // 🔴 NOTHING WAS DECLARED, SO NOTHING WAS CHECKED. A vacuous check is worse than no check, because
      // the step reports VERIFIED: this gate's whole contract is "every declared produce was committed
      // with non-empty content", and over zero declarations it certified on zero evidence — worst exactly
      // where it fires, since the engine substitutes `artifact_present` precisely when the model gave
      // neither a check nor a `produces`.
      //
      // ⚠️ It is `inconclusive`, not a plain failure, and the distinction is the one this file already
      // draws for `file_exists`: `ok: false` says *the subject did not meet the check*, and claiming that
      // here would be a fabricated observation about work we never looked at. What failed is our
      // INSTRUMENT — it had nothing to measure. `ok` stays `false` because the gate certifies, and it may
      // not certify what it could not check; the detail names the fault as ours and says how to make the
      // step checkable. The one thing that can still certify such a step is a verifier that reads the real
      // workspace (the engine's goal check), which is where the engine routes this.
      return Effect.succeed({
        ok: false,
        inconclusive: true,
        detail:
          "this step declared no `produces`, so an `artifact_present` check had NOTHING to check — passing " +
          "it would certify the step on zero evidence, and this says NOTHING about whether the work was " +
          "done. Make the step checkable: either declare in `produces` the artifact this step writes, or " +
          "give a `check` that RUNS something (`compile`, `run`, `output_equals`) or names a file " +
          "(`file_exists`).",
      })
    }
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
          // A `compile` runs the compiler, not the workspace's product — only a `run` is "program output".
          const ran: { runOutput?: string } = check.type === "run" ? { runOutput: r.output } : {}
          if (r.exitCode !== 0) return { ok: false, detail: tail(r.output), ...ran }
          if (check.type === "run" && check.expect !== undefined && !r.output.includes(check.expect)) {
            return { ok: false, detail: tail(`expected output to contain "${check.expect}"; got: ${r.output}`), ...ran }
          }
          return { ok: true, detail: "", ...ran }
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
          // 🔴 THE STRONGEST GATE MUST BE THE STRICTEST. `output_equals` outranks `run` (engine `checkRank`:
          // 4 vs 3) and a step's check may only ever be swapped for one that ranks at least as high — yet
          // `run` one case up has always failed a non-zero exit and this one did not. So the ONE check the
          // engine trusts most was the ONE a program could pass by printing the right answer and THEN
          // crashing: an exit code is the program's own verdict on whether it produced that answer or died
          // partway through printing it, and a gate that reads the text but not the verdict is grading a
          // fragment. Ordered BEFORE the equality test so a crash is never reported as a text mismatch.
          if (r.exitCode !== 0)
            return {
              ok: false,
              runOutput: r.output,
              detail: tail(
                `the command FAILED — it exited ${r.exitCode ?? "non-zero"} instead of 0, so it did not run to ` +
                  `completion and its output is not a result` +
                  (got === want
                    ? ". The text it printed before failing DID match the expected output, so the computation is " +
                      "close: find why it exits non-zero (a crash, an abort, an uncaught error, or an explicit " +
                      "non-zero exit AFTER printing), fix that, and re-run."
                    : ".") +
                  `\n${r.output}`,
              ),
            }
          return got === want
            ? { ok: true, detail: "", runOutput: r.output }
            : { ok: false, detail: `expected ${clip(want, 200)}, got ${clip(got, 200)}`, runOutput: r.output }
        }),
      )
    }
  }
}
