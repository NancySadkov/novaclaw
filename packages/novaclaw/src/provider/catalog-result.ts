export * as ProviderCatalogResult from "./catalog-result"

// The `/provider` + `/config` providers wire: the V2 catalog shapes
// (ProviderV2.Info / ModelV2.Info) verbatim, plus the derived connected set and
// per-provider default model. No projection layer — clients consume catalog truth.

import { Schema, Types } from "effect"
import { sortBy } from "remeda"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ModelV2 } from "@novaclaw/core/model"

export const ListResult = Schema.Struct({
  providers: Schema.Array(ProviderV2.Info),
  models: Schema.Array(ModelV2.Info),
  connected: Schema.Array(Schema.String),
  default: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "ProviderCatalog" })
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(
    models,
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

/** Every non-disabled provider that owns at least one model; `connected` = available ids. */
export function listResult(input: {
  providers: readonly ProviderV2.Info[]
  models: readonly ModelV2.Info[]
  connected: readonly string[]
}): ListResult {
  const byProvider = new Map<string, ModelV2.Info[]>()
  for (const model of input.models) {
    const list = byProvider.get(model.providerID) ?? []
    list.push(model)
    byProvider.set(model.providerID, list)
  }
  const providers = input.providers.filter((p) => !p.disabled && (byProvider.get(p.id)?.length ?? 0) > 0)
  const kept = new Set<string>(providers.map((p) => p.id))
  const defaults: Record<string, string> = {}
  for (const provider of providers) {
    const preferred = byProvider.get(provider.id)!.filter((m) => m.status !== "deprecated")
    defaults[provider.id] = sort(preferred.length > 0 ? preferred : byProvider.get(provider.id)!)[0].id
  }
  return {
    providers,
    models: input.models.filter((m) => kept.has(m.providerID)),
    connected: input.connected.filter((id) => kept.has(id)),
    default: defaults,
  } as ListResult
}
