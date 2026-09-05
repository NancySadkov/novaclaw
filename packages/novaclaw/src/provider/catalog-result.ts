export * as ProviderCatalogResult from "./catalog-result"

// The `/provider` + `/config` providers wire: the V2 catalog shapes
// (ProviderV2.Info / ModelV2.Info) verbatim, plus the derived connected set and
// per-provider default model. No projection layer — clients consume catalog truth.

import { Effect, Schema, Types } from "effect"
import { sortBy } from "remeda"
import { Catalog } from "@novaclaw/core/catalog"
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

/**
 * **The ONE read that produces a provider catalog.** Four calls in a fixed order — `provider.all`,
 * `model.all`, `provider.available`, then `listResult` — written out twice: once in
 * `cli/cmd/models.ts` and once in `httpapi/handlers/provider.ts`. The two bodies were identical
 * (), so a change to what "the catalog" means had to be made in two places, and the CLI
 * silently answering a different question from the HTTP route is a failure nothing would report.
 *
 * ⚠️ **The PROVISION deliberately stays at the call sites, because it is the one thing that
 * genuinely differs.** This is an `Effect` requiring `Catalog.Service`, i.e. the location-scoped
 * graph; the CLI resolves that for `process.cwd()` and the handler for
 * `InstanceState.context.directory`. Folding the directory in here would mean this module choosing
 * between them, which is exactly the decision that must stay visible at each caller. The CLI's
 * `PluginV2.ready` await stays there too — it is a bare-process concern (a fast CLI can otherwise
 * read the store before the plugin batch lands) and the server has already done it.
 */
export const listCatalog = Effect.gen(function* () {
  const catalog = yield* Catalog.Service
  const providers = yield* catalog.provider.all()
  const models = yield* catalog.model.all()
  const available = yield* catalog.provider.available()
  return listResult({ providers, models, connected: available.map((provider) => provider.id) })
})

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
