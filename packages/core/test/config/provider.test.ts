import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@novaclaw/core/catalog"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { Config } from "@novaclaw/core/config"
import { ConfigProviderPlugin } from "@novaclaw/core/config/plugin/provider"
import { Integration } from "@novaclaw/core/integration"
import { ModelV2 } from "@novaclaw/core/model"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginHost } from "@novaclaw/core/plugin/host"
import { ProviderV2 } from "@novaclaw/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

// 8c: the plugin reads ONLY the instance-wide CatalogStore (documents no longer exist at
// runtime); tests pre-populate the store layers the import seeds would have written.
const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

// Models-primary (notes/models-primary-plan.md P1): the flat top-level `models` map is accepted
// IN PARALLEL with the nested `providers` shape. This just proves the schema round-trips the flat
// shape (url + params + tier + variants) and that the two shapes coexist in one document; the P2
// seed-equivalence gate proves they produce the SAME catalog.
describe("Config.Info models-primary schema (P1)", () => {
  it.effect("decodes a flat top-level models map with url, params and tier", () =>
    Effect.sync(() => {
      const info = decode({
        model: "qwen3.6-35b",
        models: {
          "qwen3.6-35b": {
            name: "Qwen 3.6 35B",
            url: "http://192.168.178.40:8000/v1",
            tier: "small",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            request: { body: { temperature: 0.7, top_p: 0.8 } },
            variants: [{ id: "high", body: { reasoning_effort: "high" } }],
            limit: { context: 262144, output: 32768 },
          },
        },
      })
      const model = required(info.models?.["qwen3.6-35b"])
      expect(model.url).toBe("http://192.168.178.40:8000/v1")
      expect(model.tier).toBe("small")
      expect(model.name).toBe("Qwen 3.6 35B")
      expect(model.request?.body).toEqual({ temperature: 0.7, top_p: 0.8 })
      expect(model.variants?.[0]?.id).toBe(ModelV2.VariantID.make("high"))
      expect(model.limit?.context).toBe(262144)
    }),
  )

  it.effect("accepts both the nested providers shape and the flat models shape in one document", () =>
    Effect.sync(() => {
      const info = decode({
        providers: { legacy: { api: { type: "native", settings: {} }, models: { chat: { name: "Chat" } } } },
        models: { "flat-model": { url: "https://flat.test/v1" } },
      })
      expect(info.providers?.legacy?.models?.chat?.name).toBe("Chat")
      expect(info.models?.["flat-model"]?.url).toBe("https://flat.test/v1")
    }),
  )

  it.effect("rejects an unknown capability tier", () =>
    Effect.sync(() => {
      expect(() => decode({ models: { m: { tier: "supergalactic" } } })).toThrow()
    }),
  )

  it.effect("carries a configured capability tier through to the catalog ModelV2.Info", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const store = yield* CatalogStore.Service
      const providerID = ProviderV2.ID.make("tiered")
      const modelID = ModelV2.ID.make("small-model")
      yield* store.setLayers(providerID, [
        decode({
          providers: {
            tiered: {
              api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://tiered.test/v1" },
              models: { "small-model": { name: "Small", tier: "small" } },
            },
          },
        }).providers!.tiered,
      ])
      yield* addPlugin()
      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.tier).toBe("small")
    }),
  )
})

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const store = yield* CatalogStore.Service
      const providerID = ProviderV2.ID.make("novaclaw")
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      yield* store.setLayers(providerID, [
        decode({
          providers: {
            novaclaw: {
              api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://novaclaw.test/v1" },
              models: {
                "alpha-gpt-next": {
                  variants: [
                    {
                      id: "high",
                      body: {
                        reasoningEffort: "high",
                        reasoningSummary: "auto",
                        include: ["reasoning.encrypted_content"],
                      },
                    },
                  ],
                },
              },
            },
          },
        }).providers!.novaclaw,
      ])

      yield* addPlugin()

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const store = yield* CatalogStore.Service
      const providerID = ProviderV2.ID.make("novaclaw")
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      yield* store.setLayers(providerID, [
        decode({
          providers: {
            novaclaw: {
              api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://novaclaw.test/v1" },
            },
          },
        }).providers!.novaclaw,
        decode({
          providers: {
            novaclaw: {
              models: {
                "alpha-gpt-next": {
                  variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                },
              },
            },
          },
        }).providers!.novaclaw,
      ])

      yield* addPlugin()

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const store = yield* CatalogStore.Service
        const integrations = yield* Integration.Service
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        yield* store.setLayers(providerID, [
          decode({
            providers: {
              custom: {
                name: "Configured",
                env: ["CUSTOM_API_KEY"],
                api: { type: "native", settings: {} },
                request: request({ first: "first", shared: "first" }),
                models: {
                  chat: {
                    name: "First",
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    disabled: true,
                    limit: { context: 100, output: 50 },
                    cost: { input: 1, output: 2 },
                    request: request({ first: "first", shared: "first" }, "retained"),
                    variants: [
                      {
                        id: "fast",
                        headers: { first: "first", shared: "first" },
                      },
                    ],
                  },
                },
              },
            },
          }).providers!.custom,
          decode({
            providers: {
              custom: {
                api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                request: request({ last: "last", shared: "last" }),
                models: {
                  default: {
                    name: "Default",
                  },
                  chat: {
                    api: { id: "api-chat" },
                    name: "Last",
                    limit: { output: 75 },
                    request: request({ last: "last", shared: "last" }),
                    variants: [
                      {
                        id: "fast",
                        headers: { last: "last", shared: "last" },
                      },
                      {
                        id: "slow",
                        headers: { slow: "slow" },
                      },
                    ],
                  },
                },
              },
            },
          }).providers!.custom,
          decode({
            providers: {
              custom: { name: "Renamed" },
            },
          }).providers!.custom,
        ])
        // The import seed stores the latest() `model` ref as the default (custom/default here).
        yield* store.setDefault("custom/default")

        yield* addPlugin()

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("default"))
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        expect(provider.api).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
        expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
        expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.request.variant).toBe("retained")
        expect(model.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )
})
