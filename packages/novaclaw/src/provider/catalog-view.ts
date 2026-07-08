export * as ProviderCatalogView from "./catalog-view"

// V1 provider WIRE shapes + a projector from the V2 `Catalog` (ProviderV2.Info /
// ModelV2.Info) onto them. This is the bridge that lets the Models-UI keep its
// existing `/provider` + `/config` response contract after the V1 provider layer
// (with its AI-SDK inference path) was deleted. It is pure metadata: no service,
// no AI-SDK, no runtime. When the UI is migrated to consume V2 catalog shapes
// directly (the Models-primary / Config→SQLite program), this file goes away.

import { Schema, Types } from "effect"
import { mapValues, sortBy } from "remeda"
import { optional } from "@novaclaw/core/schema"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ModelV2 } from "@novaclaw/core/model"
import { ModelStatus } from "./model-status"

// --- V1 wire schemas (relocated verbatim from the deleted provider.ts) ---

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optional(Schema.Finite),
  output: Schema.Finite,
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  family: optional(Schema.String),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

// --- Pure helpers (relocated verbatim) ---

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(provider, (_, value) => {
      if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
      if (typeof value === "bigint") return value.toString()
      return value
    }),
  )
}

export function defaultModelIDs<T extends { models: Record<string, { id: string }> }>(providers: Record<string, T>) {
  return mapValues(providers, (item) => sort(Object.values(item.models))[0].id)
}

const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(
    models,
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(rest.join("/")),
  }
}

// --- V2 Catalog → V1 wire projection ---

const modalities = (arr: readonly string[]) => ({
  text: arr.some((m) => m.startsWith("text")),
  audio: arr.some((m) => m.startsWith("audio")),
  image: arr.some((m) => m.startsWith("image")),
  video: arr.some((m) => m.startsWith("video")),
  pdf: arr.some((m) => m.startsWith("pdf")),
})

// Map one projected `ModelV2.Info` onto the V1 `Model` wire shape. Only the fields
// the Models-UI reads need be faithful (id/name/release_date/family/status/
// cost.input/limit.context/capabilities.reasoning+input/variant KEYS); the rest are
// best-effort or defaulted (the UI ignores them). See the converter map in the
// F1-final Part-3 analysis.
export function toModel(model: ModelV2.Info): Model {
  const base = model.cost.find((c) => c.tier === undefined) ?? model.cost[0]
  const tiers = model.cost.flatMap((c) =>
    c.tier === undefined ? [] : [{ input: c.input, output: c.output, cache: c.cache, tier: c.tier }],
  )
  return {
    id: model.id,
    providerID: model.providerID,
    api: {
      id: model.api.id,
      url: model.api.url ?? "",
      npm: model.api.type === "aisdk" ? model.api.package : "@ai-sdk/openai-compatible",
    },
    name: model.name,
    ...(model.family ? { family: model.family } : {}),
    capabilities: {
      // V2 has no explicit temperature/attachment/interleaved flags; reasoning is
      // inferred from the precomputed reasoning-effort variants. Only `reasoning` +
      // `input.*` + `toolcall` are read by the UI.
      temperature: true,
      reasoning: model.variants.length > 0,
      attachment: model.capabilities.input.some((m) => !m.startsWith("text")),
      toolcall: model.capabilities.tools,
      input: modalities(model.capabilities.input),
      output: modalities(model.capabilities.output),
      interleaved: false,
    },
    cost: {
      input: base?.input ?? 0,
      output: base?.output ?? 0,
      cache: { read: base?.cache.read ?? 0, write: base?.cache.write ?? 0 },
      ...(tiers.length > 0 ? { tiers } : {}),
    },
    limit: {
      context: model.limit.context,
      ...(model.limit.input !== undefined ? { input: model.limit.input } : {}),
      output: model.limit.output,
    },
    status: model.status,
    options: {},
    headers: {},
    release_date: new Date(model.time.released).toISOString(),
    // The picker/agent-variant code reads `Object.keys(variants)`; values are ignored.
    variants: Object.fromEntries(model.variants.map((v) => [v.id, v.body as Record<string, unknown>])),
  }
}

function toInfo(provider: ProviderV2.Info, models: ModelV2.Info[], connected: boolean): Info {
  return {
    id: provider.id,
    name: provider.name,
    // The UI uses `source` only for a display tag + `canDisconnect` (env → locked).
    // Catalog providers are config/credential-derived, never env-locked here.
    source: connected ? "config" : "api",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((m) => [m.id, toModel(m)])),
  }
}

// Group `models` by provider and project each listed (non-disabled) provider that
// has at least one model into a V1 `Info`. `connected` are the provider ids that
// are actually available (credentials/integration present).
function infoMap(
  providers: readonly ProviderV2.Info[],
  models: readonly ModelV2.Info[],
  connected: ReadonlySet<string>,
): Record<string, Info> {
  const byProvider = new Map<string, ModelV2.Info[]>()
  for (const model of models) {
    const list = byProvider.get(model.providerID) ?? []
    list.push(model)
    byProvider.set(model.providerID, list)
  }
  const result: Record<string, Info> = {}
  for (const provider of providers) {
    if (provider.disabled) continue
    const owned = byProvider.get(provider.id) ?? []
    if (owned.length === 0) continue
    result[provider.id] = toInfo(provider, owned, connected.has(provider.id))
  }
  return result
}

/** `/provider` list: every non-disabled provider with models; `connected` = available ids. */
export function listResult(input: {
  providers: readonly ProviderV2.Info[]
  models: readonly ModelV2.Info[]
  connected: readonly string[]
}): ListResult {
  const connected = new Set(input.connected)
  const map = infoMap(input.providers, input.models, connected)
  return {
    all: Object.values(map).map(toPublicInfo),
    default: defaultModelIDs(map),
    connected: input.connected.filter((id) => map[id] !== undefined),
  }
}

/** `/config` providers: only the connected/available providers + their models. */
export function configProvidersResult(input: {
  providers: readonly ProviderV2.Info[]
  models: readonly ModelV2.Info[]
}): ConfigProvidersResult {
  const connected = new Set(input.providers.map((p) => p.id))
  const map = infoMap(input.providers, input.models, connected)
  return {
    providers: Object.values(map).map(toPublicInfo),
    default: defaultModelIDs(map),
  }
}
