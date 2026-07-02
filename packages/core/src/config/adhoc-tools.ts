export * as ConfigAdhocTools from "./adhoc-tools"

import { Schema } from "effect"

// P4 (4D, global/project scopes): config-defined ad-hoc tool recipes. Same shape on V1 and
// V2 configs; migrate.ts copies it through (the persona pattern). Session-scoped recipes are
// NOT config — `define_tool` persists them per session so a model can never silently mutate
// the user's config.
export const Recipe = Schema.Struct({
  name: Schema.String.annotate({
    description: "Tool name (lowercase slug) listed in the system prompt",
  }),
  description: Schema.String.annotate({
    description: "One-line description shown beside the name (the model decides from this alone)",
  }),
  manual: Schema.String.annotate({
    description: "Free-text manual the model pulls on demand: the API shape plus 1-2 curl/shell examples",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Set false to hide the recipe without deleting it (a later scope can disable an earlier one)",
  }),
})
export type Recipe = typeof Recipe.Type

export const Info = Schema.Array(Recipe)
export type Info = typeof Info.Type
