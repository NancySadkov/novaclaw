export * as ConfigIntrospection from "./introspection"

import { Schema } from "effect"

// The P2 introspection-mode config. Same shape on V1 and V2 configs; migrate.ts copies it
// through (the persona pattern). The judge periodically asks a (possibly different) model
// whether the session is stuck; on "yes" an interjection is steered into the next turn.
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Periodically ask an introspecting model whether the session is stuck (default: false)",
  }),
  cadence: Schema.optional(Schema.Number).annotate({
    description: "Judge every N continuation steps within a turn drain (default: 3)",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: 'Introspecting model as "provider/model" (default: the active turn\'s model)',
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "The question the judge is asked about the recent context (default: the stuck/looping check)",
  }),
  interjection: Schema.optional(Schema.String).annotate({
    description: 'Text injected into the introspected session when the judge answers "yes"',
  }),
  generateInterjection: Schema.optional(Schema.Boolean).annotate({
    description: "Let the introspecting model WRITE the interjection instead of using the fixed text (default: false)",
  }),
})
export type Info = typeof Info.Type
