export * as ConfigPersona from "./persona"

import { Schema } from "effect"

// The B3 persona baseline config. Same shape on V1 and V2 configs; migrate.ts copies it through.
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Prepend the persona baseline to every agent's system prompt (default: true)",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Persona name substituted into the default prompt (default: Nova)",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "Replace the default persona prompt wholesale",
  }),
})
export type Info = typeof Info.Type
