export * as Provider from "./provider"

import { Schema } from "effect"
import { optional } from "./schema"
import { ConfigAnnotation } from "./config-annotation"
import { Integration } from "./integration"
import { statics } from "./schema"

/**
 * The provider SDK's own options object, reachable from config as `providers.<id>.api.settings`.
 *
 * ⚠️ Its `apiKey` entry is a LIVE credential — `core/session/runner/model.ts:202` reads
 * `model.request.body.apiKey ?? model.api.settings?.apiKey` — while `baseURL` and the rest are
 * ordinary settings an agent must be able to read back in order to repair a moved endpoint. So the
 * marker names the entry rather than the record; see `config-annotation.ts` → `secretEntries`.
 */
const Settings = ConfigAnnotation.secretEntries(Schema.Record(Schema.String, Schema.Unknown), ["apiKey"])

export const ID = Schema.String.pipe(
  Schema.brand("ProviderV2.ID"),
  statics((schema) => ({
    novaclaw: schema.make("novaclaw"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    gitlab: schema.make("gitlab"),
  })),
)
export type ID = typeof ID.Type

export interface AISDK extends Schema.Schema.Type<typeof AISDK> {}
export const AISDK = Schema.Struct({
  type: Schema.Literal("aisdk"),
  package: Schema.String,
  url: Schema.String.pipe(optional),
  settings: Settings.pipe(optional),
}).annotate({ identifier: "Provider.AISDK" })

export interface Native extends Schema.Schema.Type<typeof Native> {}
export const Native = Schema.Struct({
  type: Schema.Literal("native"),
  url: Schema.String.pipe(optional),
  settings: Settings,
}).annotate({ identifier: "Provider.Native" })

export const Api = Schema.Union([AISDK, Native])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Provider.Api" })
export type Api = typeof Api.Type

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: "Provider.Request" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  integrationID: Integration.ID.pipe(optional),
  name: Schema.String,
  disabled: Schema.Boolean.pipe(optional),
  api: Api,
  request: Request,
})
  .annotate({ identifier: "ProviderV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (id: ID) =>
        schema.make({
          id,
          name: id,
          api: { type: "native", settings: {} },
          request: { headers: {}, body: {} },
        }),
    })),
  )
