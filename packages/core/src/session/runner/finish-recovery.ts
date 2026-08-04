export * as FinishRecovery from "./finish-recovery"

import type { FinishReason } from "@novaclaw/llm"

/**
 * F2 — output-token TRUNCATION recovery.
 *
 * Ported from the outside GitHub PR https://github.com/NancySadkov/novaclaw/pull/4 by
 * @DassaultFalconKing (written against the v0.1.0 release snapshot, which shares no ancestor with
 * this tree — see AGENTS.md *GitHub is a RELEASE SURFACE*). Their diagnosis and their two-strike
 * shape are kept; the counter, the bounds and the wiring are ours.
 *
 * **The failure.** A provider that stops at its own output-token limit reports
 * `finishReason === "length"` and leaves the turn TRUNCATED: the assistant message ends
 * mid-sentence — or, when the whole budget went into reasoning, with no content at all (measured
 * against qwen3.6-35b: `max_tokens=2048 -> finish=length, completion=2048, content 0 chars`; the
 * table lives in `runner/llm.ts`'s auto-title note). Nothing downstream can tell that apart from a
 * finished answer, so the drain either drops the tail silently or, if it re-prompts on a heuristic,
 * re-prompts against a wall it cannot move.
 *
 * **The shape.** Steer ONCE to continue from the cutoff, then STOP HONESTLY with a notice that
 * names the real fix (a larger output budget, or smaller steps). This is the shape the
 * thinking-budget work already paid for: *every phase bounded, plus a MECHANICAL hard stop* — an
 * informational nudge does not converge a model that is simply out of tokens, and the runaway that
 * taught us that cost real money.
 *
 * **Why it matters here.** `dgx-spark/qwen3.6-35b` is the floor and the only test model (AGENTS.md
 * *Test model*), and burning the output budget before answering is one of its characteristic
 * failures — exactly the horizon the Juvenile Harness exists to supply.
 *
 * PURE — no Effect, no db, no clock. The runner supplies the settled finish reason, whether the
 * turn already continues on its own, and the per-drain state.
 *
 * ⚠️ NOT ported: upstream gated this behind a `completionGuard` per-session toggle. That needs a
 * config column + a migration and is its own later unit; this lands ALWAYS-ON, which is safe
 * precisely because the two-strike bound below is unconditional. A per-session switch is a
 * follow-up, and it belongs in the standard per-session config-toggle chain, not in an `enabled`
 * parameter threaded through a pure decider.
 */

/**
 * How many times one drain may steer a truncated turn back to work. ONE: the first `length` finish
 * is plausibly a long answer that needed a little more room; the second says the budget itself is
 * wrong, and no wording fixes that.
 */
export const MAX_RECOVERIES = 1

/**
 * `"length"` as the provider layer spells it. Declared with the schema's own type so this file
 * cannot drift from `@novaclaw/llm`'s `FinishReason` union: if the literal is ever renamed or
 * dropped, this line stops compiling instead of silently never matching.
 *
 * The parameter below is a bare `string` on purpose — the runner's event publisher widens
 * `step-finish`'s reason to `string` when it stashes the settlement (`publish-llm-event.ts`), so
 * demanding the narrow type here would only buy a cast at the call site.
 */
const LENGTH: FinishReason = "length"

/** Per-DRAIN recovery ledger. See `initialState` for why the drain is the right lifetime. */
export interface State {
  recoveries: number
}

export type Decision =
  /** Not a truncation, or the drain already continues on its own — do nothing. */
  | { readonly kind: "none" }
  /** Steer `message` (through `SessionInput.steer`, which stamps the 1N provenance prefix). */
  | { readonly kind: "continue"; readonly message: string }
  /** Surface `notice` to the user and end the drain rather than truncate again. */
  | { readonly kind: "stop"; readonly notice: string }

/**
 * A fresh ledger. The runner holds ONE of these per DRAIN, next to the doom-loop latches and the
 * self-drive rounds — deliberately neither narrower nor wider:
 *
 * · **per turn** would reset before it could ever read as 1, so `decide` would answer `continue`
 *   forever — the counter would exist and never trip. That is the upstream bug in a different
 *   costume (see `decide`).
 * · **per session** would trip PERMANENTLY: two truncations in one long morning would leave every
 *   later, unrelated request unable to recover, and nothing would ever clear it.
 * · **per drain** re-arms on any new input — the user answering the notice IS the new drain — while
 *   staying bounded within a single autonomous stretch, which is the only place a loop can run away
 *   unattended. It matches `SessionDrive`'s rounds cap and the `nudged`/`regrounded`/`textualNudged`
 *   latches exactly.
 */
export const initialState = (): State => ({ recoveries: 0 })

const CONTINUE_MESSAGE =
  "Your previous response was cut off by the model's output-token limit — it stopped mid-way, not " +
  "because the work was finished. Continue from exactly where it stopped, and do not repeat or redo " +
  "anything you already completed. First re-read the file or tool result you were working on so you " +
  "continue from its real current state, then take ONE small next action that fits comfortably inside " +
  "a single response."

const STOP_NOTICE =
  "⏸️ The model ran out of output tokens twice in a row, so this run paused instead of looping on " +
  "truncated answers. Raise the model's output/reasoning budget, or ask for the work in smaller " +
  "pieces — then send any message to continue."

/**
 * One truncation decision, taken once per settled turn — **and it RECORDS the recovery it hands
 * out**, which is the whole reason this reads as a mutator rather than as a pure `decide`.
 *
 * ⚠️ THE UPSTREAM BUG. The PR's version compared `state.recoveries === 0` and nothing, anywhere,
 * ever wrote `state.recoveries`. `initialState()` produced `{ recoveries: 0 }`, so every call
 * returned `continue`: the "stop" arm was unreachable and the guard against a truncation loop was
 * itself the truncation loop, steering a starved model forever. It compiles green and it type-checks
 * — the exact class of defect that ships when only the caller can keep the invariant. So the ONLY
 * writer of the counter is the function that reads it, and the two-strikes boundary is pinned by
 * `finish-recovery.test.ts` calling `decide` twice against one state.
 *
 * A non-`length` finish is left completely alone, and the counter is deliberately **not** reset by
 * one: an alternating `length` → `stop` → `length` sequence must still terminate, so the bound is
 * per-drain and monotone rather than per-streak. (A drain that legitimately needs a third long
 * answer gets it the moment the user replies — that is a new drain.)
 *
 * @param reason the settled `step-finish` reason, or `undefined` when the turn never settled
 * @param needsContinuation whether the drain already runs another step (a tool call landed) — then
 *   the model gets its next turn regardless and there is nothing to steer
 */
export function decide(reason: string | undefined, needsContinuation: boolean, state: State): Decision {
  if (reason !== LENGTH || needsContinuation) return { kind: "none" }
  if (state.recoveries < MAX_RECOVERIES) {
    state.recoveries++
    return { kind: "continue", message: CONTINUE_MESSAGE }
  }
  return { kind: "stop", notice: STOP_NOTICE }
}
