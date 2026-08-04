export * as ConfigAffective from "./affective"

import { Schema } from "effect"

// P3 — the affective-mode config. Same shape on V1 and V2 configs; migrate.ts copies it
// through (the persona pattern). When enabled, a per-session mood modulates sampling around
// the model's configured baseline and injects a redirect at high frustration/urgency.
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Emotion-modulated sampling + loop-breaking nudges (default: false)",
  }),
  temperature: Schema.optional(Schema.Number).annotate({
    description: "Calm-baseline temperature when the model config sets none (default: 0.7)",
  }),
  extended: Schema.optional(Schema.Boolean).annotate({
    description: "Also modulate extended params (top_k) — for engines that accept them (default: false)",
  }),
})
export type Info = typeof Info.Type
