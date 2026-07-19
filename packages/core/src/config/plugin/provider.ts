export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/internal"
import { Effect } from "effect"
import { CatalogStore } from "../../catalog-store"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const store = yield* CatalogStore.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        // Config→SQLite 8c: provider fragments come from the instance-wide CatalogStore layers
        // (config documents no longer exist at runtime). `env: []` must count as ABSENT: an env
        // method with zero names can never produce a credential, but its mere existence creates
        // an integration record — and a provider with an integration record and no connections
        // drops out of catalog availability (catalog.ts `available`). V1 configs commonly
        // carried `env: []` for keyless/local endpoints, which would silently disable the
        // provider.
        const layers = yield* store.providers()
        const configuredIntegrations = new Set(
          Object.entries(layers).flatMap(([id, list]) =>
            list.some((item) => item.env !== undefined && item.env.length > 0) ? [id] : [],
          ),
        )
        for (const [id, list] of Object.entries(layers)) {
          for (const item of list) {
            const integrationID = id
            if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            integrations.update(integrationID, (integration) => {
              integration.name = item.name ?? integration.name
            })
            if (item.env !== undefined && item.env.length > 0) {
              integrations.method.update({
                integrationID,
                method: { type: "env", names: [...item.env] },
              })
            }
          }
        }
      }),
    )

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        // Populate the catalog from the instance-wide store (the source of truth). Global store + this
        // per-location transform ⇒ every location (incl. the scratch dir) sees the same providers.
        const storedDefault = yield* store.getDefault()
        if (storedDefault !== undefined) {
          const model = ModelV2.parse(storedDefault)
          catalog.model.default.set(model.providerID, model.modelID)
        }
        for (const [id, itemLayers] of Object.entries(yield* store.providers())) {
          const providerID = ProviderV2.ID.make(id)
          for (const item of itemLayers) {
            catalog.provider.update(providerID, (provider) => {
              if (item.name !== undefined) provider.name = item.name
              if (item.api !== undefined) provider.api = { ...item.api }
              if (item.request !== undefined) {
                Object.assign(provider.request.headers, item.request.headers)
                Object.assign(provider.request.body, item.request.body)
              }
            })
            for (const [modelID, config] of Object.entries(item.models ?? {})) {
              catalog.model.update(providerID, modelID, (model) => {
                if (config.family !== undefined) model.family = config.family
                if (config.tier !== undefined) model.tier = config.tier
                if (config.name !== undefined) model.name = config.name
                if (config.api !== undefined) model.api = { ...model.api, ...config.api }
                if (config.capabilities !== undefined) {
                  model.capabilities = {
                    tools: config.capabilities.tools,
                    input: [...config.capabilities.input],
                    output: [...config.capabilities.output],
                  }
                }
                if (config.request !== undefined) {
                  Object.assign(model.request.headers, config.request.headers)
                  Object.assign(model.request.body, config.request.body)
                  if (config.request.variant !== undefined) model.request.variant = config.request.variant
                }
                if (config.variants !== undefined) {
                  for (const variant of config.variants) {
                    let existing = model.variants.find((item) => item.id === variant.id)
                    if (!existing) {
                      existing = {
                        id: variant.id,
                        headers: {},
                        body: {},
                      }
                      model.variants.push(existing)
                    }
                    Object.assign(existing.headers, variant.headers)
                    Object.assign(existing.body, variant.body)
                  }
                }
                if (config.cost !== undefined) {
                  model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                    tier: cost.tier && { ...cost.tier },
                    input: cost.input,
                    output: cost.output,
                    cache: {
                      read: cost.cache?.read ?? 0,
                      write: cost.cache?.write ?? 0,
                    },
                  }))
                }
                if (config.disabled !== undefined) model.enabled = !config.disabled
                if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
              })
            }
          }
        }
      }),
    )
  }),
})
