export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/internal"
import { Effect } from "effect"
import { CatalogStore } from "../../catalog-store"
import { Config } from "../../config"
import { ConfigProvider } from "../provider"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const store = yield* CatalogStore.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const configuredIntegrations = new Set(
          files.flatMap((file) =>
            Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
              provider.env === undefined ? [] : [id],
            ),
          ),
        )
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const integrationID = id
            if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            integrations.update(integrationID, (integration) => {
              integration.name = item.name ?? integration.name
            })
            if (item.env !== undefined) {
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
        // Transitional jsonc seed (one-time): import an existing novaclaw.jsonc into the instance-wide
        // store the first time it is empty, so an existing config carries over. jsonc is import/export
        // only — this is the sole remaining runtime jsonc read for the catalog and is removed in
        // migration step 8 (once the settings UI writes the store directly).
        if (yield* store.isEmpty()) {
          const entries = yield* config.entries()
          const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
          const layers: Record<string, ConfigProvider.Info[]> = {}
          for (const file of files)
            for (const [id, item] of Object.entries(file.info.providers ?? {})) (layers[id] ??= []).push(item)
          for (const [id, providerLayers] of Object.entries(layers))
            yield* store.setLayers(ProviderV2.ID.make(id), providerLayers)
          const configuredDefault = Config.latest(entries, "model")
          if (configuredDefault !== undefined) yield* store.setDefaultIfEmpty(configuredDefault)
        }

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
