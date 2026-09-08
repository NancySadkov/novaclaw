export * as ConfigProvider from "./provider"

import { Schema } from "effect"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"

// Models-primary capability tier — the single source of truth is `ModelV2.Tier` (schema/model.ts),
// re-exported here for config authoring.
export const Tier = ModelV2.Tier
export type Tier = ModelV2.Tier

export class Request extends Schema.Class<Request>("ConfigV2.Provider.Request")({
  // Reached from five places — `providers.<id>.request`, `providers.<id>.models.<m>.request`, that
  // model's `variants[]`, `agents.<n>.request` and `models.<id>.request` — so marking it here is what
  // makes ONE marker cover the whole Authorization-header surface.
  headers: ConfigAnnotation.secret(
    Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
      description: "Extra HTTP headers on every request to this endpoint (where an Authorization token goes).",
    }),
  ),
  // ⚠️ NOT marked wholly secret, and that is the point of `secretEntries`. `apiKey` here is a live
  // credential (`session/runner/model.ts:202` reads `model.request.body.apiKey`) while the rest of
  // this record is the repair target AGENTS.md's own decoded example writes to. Blanking the whole
  // map to hide one key would destroy the one repair the self-healing law cites as proof it works.
  body: ConfigAnnotation.secretEntries(
    Schema.Record(Schema.String, Schema.Unknown)
      .pipe(Schema.optional)
      .annotate({
        description:
          "Extra JSON merged into every request body to this endpoint — e.g. " +
          '{"chat_template_kwargs":{"enable_thinking":false}}. The `apiKey` entry is a credential.',
      }),
    ["apiKey"],
  ),
}) {}

class Cache extends Schema.Class<Cache>("ConfigV2.Model.Cost.Cache")({
  read: Schema.Finite.pipe(Schema.optional),
  write: Schema.Finite.pipe(Schema.optional),
}) {}

class Cost extends Schema.Class<Cost>("ConfigV2.Model.Cost")({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(Schema.optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Cache.pipe(Schema.optional),
}) {}

class Limit extends Schema.Class<Limit>("ConfigV2.Model.Limit")({
  context: Schema.Int.pipe(Schema.optional),
  input: Schema.Int.pipe(Schema.optional),
  output: Schema.Int.pipe(Schema.optional),
  /**
   * How many images this endpoint accepts in ONE request. Absent = unlimited, which is the only
   * honest default: we carry a number that was MEASURED, never one guessed for a stranger's server.
   *
   * 🔴 Measured 2026-08-19 on the Spark's holo3.1: `HTTP 400 — At most 3 image(s) may be provided
   * in one prompt`, from vLLM's `--limit-mm-per-prompt` (a sparkrun default). Without this the
   * session DEAD-ENDS at image N+1: every later turn re-lowers the same history and re-fails.
   * `budgetImages` (session/runner/to-llm-message.ts) degrades the oldest images to a notice.
   */
  images: Schema.Int.pipe(Schema.optional),
}) {}

class Retry extends Schema.Class<Retry>("ConfigV2.Model.Retry")({
  /** Total connection attempts, including the first request. The runner clamps this to a safe range. */
  attempts: Schema.Int,
}) {}

const ModelApi = Schema.Union([
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.AISDK.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.Native.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID,
  }),
])

class Model extends Schema.Class<Model>("ConfigV2.Model")({
  family: ModelV2.Family.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  api: ModelApi.pipe(Schema.optional),
  capabilities: ModelV2.Capabilities.pipe(Schema.optional),
  request: Schema.Struct({
    ...Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Struct({
    id: ModelV2.VariantID,
    ...Request.fields,
  }).pipe(Schema.Array, Schema.optional),
  cost: Schema.Union([Cost, Cost.pipe(Schema.Array)]).pipe(Schema.optional),
  tier: Tier.pipe(Schema.optional),
  // Optional per-model pre-prompt (owner 2026-07-29): a user-authored correction for THIS model's
  // known behaviour, prepended to the system context. Declared beside `tier`, and carried onto
  // ModelV2.Info by the catalog plugin the same way. Optional ⇒ no on-read migration, no DB break.
  prePrompt: Schema.String.pipe(Schema.optional),
  retry: Retry.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  limit: Limit.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Provider")({
  name: Schema.String.pipe(Schema.optional),
  env: Schema.String.pipe(Schema.Array, Schema.optional),
  api: ProviderV2.Api.pipe(Schema.optional),
  request: Request.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
}) {}

// The MODELS-PRIMARY model entry: a top-level `Config.Info.models`
// map keys these by model id, each carrying its OWN endpoint `url` + params + `tier` — the flat
// successor to the provider-nested `providers.<id>.models.<id>` shape (pre-detachment residue). Reuses
// every field of the nested `Model` above and adds `url` (the served-from endpoint, the vision's
// "a provider is just the URL") + `tier`. Decoded in parallel with `providers` through P6; the
// nested path is retired only once the seed-equivalence gate (P2) and the app flip (P4) land.
export class ModelEntry extends Schema.Class<ModelEntry>("ConfigV2.ModelEntry")({
  name: Schema.String.pipe(Schema.optional),
  url: Schema.String.pipe(Schema.optional),
  family: ModelV2.Family.pipe(Schema.optional),
  api: ModelApi.pipe(Schema.optional),
  capabilities: ModelV2.Capabilities.pipe(Schema.optional),
  request: Schema.Struct({
    ...Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Struct({
    id: ModelV2.VariantID,
    ...Request.fields,
  }).pipe(Schema.Array, Schema.optional),
  cost: Schema.Union([Cost, Cost.pipe(Schema.Array)]).pipe(Schema.optional),
  tier: Tier.pipe(Schema.optional),
  // See the nested `Model.prePrompt` above — the flat models-primary entry carries the same optional
  // field, so a config authored either way (nested `providers` or flat `models`) reaches the catalog.
  prePrompt: Schema.String.pipe(Schema.optional),
  retry: Retry.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  limit: Limit.pipe(Schema.optional),
}) {}
