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
  downloadBytes: Schema.Finite,
  minimumMemoryBytes: Schema.Finite,
  workingMemoryBytes: Schema.Finite,
  contexts: Schema.Array(Schema.Finite),
})
export type Profile = Schema.Schema.Type<typeof Profile>

export const Preflight = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  memory: Schema.optional(Schema.Struct({ freeBytes: Schema.Finite, limitBytes: Schema.Finite })),
  disk: Schema.optional(Schema.Struct({ freeBytes: Schema.Finite, requiredBytes: Schema.Finite })),
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
  completed: Schema.optional(Schema.Finite),
  total: Schema.optional(Schema.Finite),
  message: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  baseURL: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  context: Schema.optional(Schema.Finite),
  output: Schema.optional(Schema.Finite),
  pid: Schema.optional(Schema.Finite),
  ramBytes: Schema.optional(Schema.Finite),
  preflight: Schema.optional(Preflight),
  recommendedContext: Schema.Finite,
})
export type Status = Schema.Schema.Type<typeof Status>
