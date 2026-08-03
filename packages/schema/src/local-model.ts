export * as LocalModel from "./local-model"

import { Schema } from "effect"

export const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  modelID: Schema.String,
  quant: Schema.String,
  license: Schema.String,
  sourceURL: Schema.String,
  downloadBytes: Schema.Number,
  minimumMemoryBytes: Schema.Number,
  workingMemoryBytes: Schema.Number,
  contexts: Schema.Array(Schema.Number),
})
export type Profile = Schema.Schema.Type<typeof Profile>

export const Preflight = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  memory: Schema.optional(Schema.Struct({ freeBytes: Schema.Number, limitBytes: Schema.Number })),
  disk: Schema.optional(Schema.Struct({ freeBytes: Schema.Number, requiredBytes: Schema.Number })),
})
export type Preflight = Schema.Schema.Type<typeof Preflight>

export const Stage = Schema.Literals([
  "idle",
  "checking",
  "downloading-runtime",
  "installing-runtime",
  "downloading-model",
  "installed",
  "starting",
  "ready",
  "stopping",
  "error",
])
export type Stage = Schema.Schema.Type<typeof Stage>

export const Status = Schema.Struct({
  supported: Schema.Boolean,
  platform: Schema.String,
  profiles: Schema.Array(Profile),
  stage: Stage,
  profileID: Schema.optional(Schema.String),
  completed: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  baseURL: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  context: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  pid: Schema.optional(Schema.Number),
  ramBytes: Schema.optional(Schema.Number),
  preflight: Schema.optional(Preflight),
  recommendedContext: Schema.Number,
})
export type Status = Schema.Schema.Type<typeof Status>
