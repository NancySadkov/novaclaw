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
   * Whether compaction may ask a model to summarize (default true). When false, it archives the
   * original conversation and retains the newest text that fits. Optional stale-output pruning
   * still applies before selecting that tail. Disabling summaries never disables overflow recovery.
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
   * `DEFAULT_SUMMARY_INPUT_TOKENS` in `session/compaction.ts`. One bounded pass retains the prior
   * summary and newest evidence; omitted evidence remains in the transcript and archive.
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
