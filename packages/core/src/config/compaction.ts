export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

/** A percentage of the model's context window, 1..100. Mirrors `ConfigV2.Context`'s `Share`. */
const ThresholdPercent = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  /**
   * Whether a compaction cycle may write an LLM SUMMARY, or stop after the cheap prune.
   *
   * Default (absent) is `true` — prune then summarise, which is what has always shipped. Setting it
   * `false` is the *prune only* tier of the compaction ladder, and it is not merely a speed knob:
   * summarising rewrites the conversation into a model's paraphrase, and a user who would rather
   * lose old TOOL OUTPUT than have their history restated now has a way to say so.
   *
   * ⚠️ Only meaningful with `prune: true`. With both off, a full context has nothing to reclaim and
   * nothing to summarise — the cycle simply declines, which is the pre-existing behaviour and not a
   * new failure mode.
   */
  summarize: Schema.Boolean.pipe(Schema.optional),
  /**
   * How many tokens of transcript the SUMMARIZER may read in one pass.
   *
   * 🔴 **Without this, the summarizer's budget was the whole context window** —
   * `promptCeiling = context - summaryOutput`, i.e. a ~258 k-token request against a 262,144-token
   * window. Measured 2026-09-14 (`ses_daedalus`): eight consecutive compaction attempts died as
   * `summarizer-unavailable` with `generatedChars: 0` and durations of 300 s / 308 s — the local
   * endpoint's stall timeout — while the chat sat 20 % over its ceiling and could not compact at
   * all. **The mechanism that exists to make the prompt smaller required sending the prompt**, so
   * compaction worked while the transcript was small and stopped working exactly when it mattered.
   *
   * ⭐ This is a budget for a PREFILL, not a fraction of the window: it must be a prompt the
   * slowest configured route can ingest inside the provider stall timeout. The default is
   * `DEFAULT_SUMMARY_INPUT_TOKENS` in `session/compaction.ts`; the head is folded in passes that
   * each stay under it.
   */
  summarizeInput: PositiveInt.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  /**
   * Where a compaction cycle fires, as a percentage of the model's context window.
   *
   * Owner, 2026-09-19: *"expose the Compaction Threshold (default 80%). Once the usage goes over
   * 80%, we do compaction."* Absent means {@link DEFAULT_COMPACTION_THRESHOLD} (80). The trigger is
   * the EARLIER of this percentage and the response-reserve ceiling (`PromptEstimate.capacity`), so
   * a window whose reserve floors demand more room still compacts before it overflows:
   * `min(ceiling, threshold%)`. It is a trigger, never a cap on what the packer may send.
   */
  threshold: ThresholdPercent.pipe(Schema.optional),
}) {}
