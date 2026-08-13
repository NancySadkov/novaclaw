export * as UnknownReason from "./unknown-reason"

import { Schema } from "effect"

/**
 * WHY a value is missing — the four answers that call for four different actions.
 *
 * `notes/reports/receipt-unknowns-vocabulary-2026-08-12.md`. Task receipts, the peak sampler, the
 * enclosure probe and the quality checks each grew their own spelling of "we do not know", and a
 * reader cannot act on a blank. This is the shared vocabulary; the spellings map onto it.
 *
 * 🔴 The distinction is the ACTION each one prescribes, not the shade of doubt:
 *
 * | reason | what happened | what the reader should do |
 * |---|---|---|
 * | `not-applicable` | there is nothing to measure; the blank is CORRECT | nothing — stop looking |
 * | `not-measured` | the measurement never ran | run it; the answer is obtainable |
 * | `measurement-failed` | it ran and produced nothing usable | investigate the instrument |
 * | `incomplete` | it started and did not finish; any value is a FLOOR | treat it as a lower bound |
 */
export const Reason = Schema.Literals(["not-applicable", "not-measured", "measurement-failed", "incomplete"]).annotate(
  { identifier: "UnknownReason" },
)
export type Reason = typeof Reason.Type

/**
 * ⚠️ **`not-applicable` is the dangerous one and must be EARNED.** It is the only term that tells a
 * reader to stop asking, so filing a merely-unmeasured value under it silently closes a question that
 * was still open.
 *
 * The worked example, from the report: the Windows enclosure probe. There is no probe *in this build*
 * — that is `not-measured`. Filing it `not-applicable` would assert that a Windows host cannot be in
 * a VM, which is false and unasked.
 */
export const STOPS_THE_READER: Reason = "not-applicable"

/** Is this reason one a reader can act on by running something? */
export const isObtainable = (reason: Reason): boolean => reason === "not-measured"

/**
 * Does this reason mean the value present beside it is a LOWER BOUND rather than the answer?
 *
 * Only `incomplete` carries a usable value at all — the other three mean there is nothing to read.
 * A caller that averages an `incomplete` alongside finished ones is averaging floors with totals.
 */
export const isFloor = (reason: Reason): boolean => reason === "incomplete"

/**
 * The known spellings already in the tree, mapped on.
 *
 * ⚠️ Kept as DATA rather than prose so the mapping can be asserted. Each entry is a decision the
 * report argued, and the two easiest to get backwards are here on purpose: `discarded` is
 * `measurement-failed` (the instrument ran and its answer was thrown away), while `unsampled` is
 * `not-measured` (it never ran) — and neither is `not-applicable`, because in both cases the quantity
 * exists and could be had.
 */
export const FROM_EXISTING_SPELLING: Readonly<Record<string, Reason>> = {
  unsampled: "not-measured",
  discarded: "measurement-failed",
  /** `complete: false` on a changes summary: the walk started and stopped, so counts are floors. */
  "complete:false": "incomplete",
  /** A refusal has no process, so it can have no exit code — the blank is correct. */
  "exit_code:null-on-refusal": "not-applicable",
  /** No enclosure probe exists on win32. The machine really might be a VM, so this is NOT n/a. */
  "enclosure:win32": "not-measured",
  "local-runtime:unknown": "measurement-failed",
}
