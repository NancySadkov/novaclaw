export * as UtilityCap from "./utility-cap"

import type { FinishReason } from "@novaclaw/llm"
import { FinishRecovery } from "./finish-recovery"

/**
 * Recovery for a UTILITY pass that spent its whole output budget and answered nothing.
 *
 * **The failure, measured 2026-08-06 against `holo3.1` with the shipped extraction prompt.** A
 * reasoning model cut off mid-think does not return a partial answer — it returns **nothing**. Every
 * cap at or below 384 finished `length` with **zero content chars** while reasoning grew 282 → 1634
 * chars; 512 and above stopped on their own at ~260–310 completion tokens with identical valid JSON.
 * So the boundary is a CLIFF, and on the wrong side of it the pass returns emptiness that
 * `parseExtraction` reads as *"nothing worth remembering"* and silently records nothing.
 *
 * ⚠️ **Why `finish-recovery.ts` is the wrong shape here, rather than something to reuse.** That
 * module steers a truncated turn to CONTINUE FROM the cutoff, which is right for a conversational
 * turn that produced half a sentence. A utility pass produces one JSON blob; when the content is
 * zero chars there is nothing to continue from, and asking the model to carry on from an empty
 * string is a request it cannot satisfy. The right move for this shape is to re-ask with room.
 *
 * ⚠️ **And this is NOT the retired "bigger is worse" inversion.** `runner/llm.ts` used to conclude
 * from a 2026-07-20 table that raising `max_tokens` made things worse — a runaway thinking loop.
 * That did not reproduce on the current test model: above the cliff a bigger cap is *neutral*, and
 * the model stops by itself. Doubling is therefore safe here in a way it was believed not to be.
 * Both tables and the ruling are in `notes/reports/utility-pass-token-cliff-2026-08-06.md`.
 *
 * **Bounded, per the thinking-budget lesson (`memory: thinking-budget-mindcontrol`): every phase gets
 * a finite ceiling and a MECHANICAL stop.** One doubling, then the pass reports honestly. An
 * informational nudge does not converge a model that is simply out of tokens, and an unbounded
 * ladder is how a runaway costs real money.
 */

/** How many times one utility pass may re-ask with a larger budget. ONE — see the bound note above. */
export const MAX_RETRIES = 1

/** Never grow a utility cap past this, however many retries a caller allows. A utility pass asks for
 *  a short string or a small JSON array; a budget this size already means something else is wrong. */
export const MAX_CAP = 4096

export interface Attempt {
  /** The provider's settled finish reason, `undefined` when the stream never produced one. */
  readonly finish: FinishReason | undefined
  /** The answer text collected from this attempt. */
  readonly text: string
  /** 0 for the first attempt. */
  readonly attempt: number
  /** The `maxTokens` this attempt asked for. */
  readonly cap: number
}

export type Decision =
  | { readonly retry: false; readonly reason: "answered" | "not-truncated" | "budget-exhausted" | "capped" }
  | { readonly retry: true; readonly cap: number }

/**
 * Should this utility pass be re-asked with a bigger budget?
 *
 * The three conditions are all necessary and each excludes a different wrong retry:
 *  · the finish reason is TRUNCATION — the model ran out of room. Any other reason means it stopped
 *    for its own reasons and re-asking would just spend tokens.
 *  · the text is EMPTY — a truncated-but-partial answer is a different problem, and re-running would
 *    throw away content the caller may still be able to use. Emptiness is what makes it a budget
 *    reading rather than a capability reading.
 *  · under the retry bound and the cap ceiling.
 */
export const decide = (attempt: Attempt): Decision => {
  if (attempt.text.trim() !== "") return { retry: false, reason: "answered" }
  // Asked through `finish-recovery.ts` rather than by naming the literal: that module is the one
  // place under `session/` allowed to spell that literal, pinned by its own ratchet, so a rename
  // breaks one line instead of silently never matching in two.
  if (!FinishRecovery.isTruncated(attempt.finish)) return { retry: false, reason: "not-truncated" }
  if (attempt.attempt >= MAX_RETRIES) return { retry: false, reason: "budget-exhausted" }
  const next = attempt.cap * 2
  if (next > MAX_CAP) return { retry: false, reason: "capped" }
  return { retry: true, cap: next }
}

/**
 * Why a utility pass gave up, as a CLOSED vocabulary rather than prose.
 *
 * ⚠️ Ruling 2 — *a fault is never described falsely*. The defect this module addresses is that an
 * empty extraction is indistinguishable from an honest "nothing to record", so the give-up path must
 * say which one it was.
 *
 * ⚠️ **It is a closed set because the log-event ledger made it one, and the ledger was right.** A
 * prose string is attribute class `text`, which by declaration never egresses — so a diagnostic
 * written as prose is one that crash telemetry can never carry, and it is unmineable besides. The
 * cause is genuinely finite here, so it costs nothing to say so and it becomes an `id` that travels.
 */
export type GiveUpCause = "budget-exhausted" | "not-a-budget-problem"

export const giveUpCause = (attempt: Attempt): GiveUpCause =>
  FinishRecovery.isTruncated(attempt.finish) ? "budget-exhausted" : "not-a-budget-problem"
