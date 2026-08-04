export * as PromptInput from "./prompt-input"

import { Schema } from "effect"
import { AgentAttachment, Origin, Source } from "./prompt"
import { optional, statics } from "./schema"

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  /**
   * The attachment's original local identity, when `uri` carries materialized bytes (the CLI inlines
   * small files as a bounded `data:` URI). Mirrors `Prompt.FileAttachment.sourceUri`, and it must:
   * this is the WIRE schema, and Effect Schema's default `onExcessProperty: "ignore"` silently DROPS
   * any field the wire type does not declare.
   *
   * ⚠️ It was missing for exactly one batch, and the consequence was that the attachment-overwrite
   * protection was inert on the only path that materializes attachments. `cli/cmd/run.ts` sent
   * `sourceUri`, decode stripped it, `Prompt.FileAttachment.sourceUri` was always `undefined`, and
   * `attachment-paths.ts` fell back to the `data:` URI — which is not a path, so nothing was
   * protected. It compiled green (excess-property checking does not fire through a `.map()`
   * callback), tested green (the unit tests build the Prompt by hand and never cross the wire), and
   * did nothing. Found 2026-07-28 by exercising the decode rather than reading it.
   */
  sourceUri: Schema.String.pipe(optional),
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "PromptInput.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) => schema.make(input),
    })),
  )

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  // Provenance of this input (the Messenger gateway sets it; local composer omits it — default
  // "user"). Passed straight through to the durable Prompt (session.ts resolvePrompt).
  origin: Origin.pipe(optional),
}).annotate({ identifier: "PromptInput" })
