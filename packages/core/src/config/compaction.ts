export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

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
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
}) {}
