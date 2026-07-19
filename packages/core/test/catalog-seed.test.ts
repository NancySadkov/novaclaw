import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CatalogSeed } from "@novaclaw/core/catalog-seed"
import { Config } from "@novaclaw/core/config"

// Models-primary P2 (notes/models-primary-plan.md): the flat `models` map must seed the SAME
// catalog as the equivalent nested `providers` shape. `expandFlatModels` is the only new logic;
// the rest of the seed is unchanged and shared, so proving the transform + decode equivalence IS
// the linchpin gate.

const decode = Schema.decodeUnknownSync(Config.Info)

const URL_A = "http://192.168.178.40:8000/v1"
const URL_B = "https://api.other.test/v1"

describe("providerIdForUrl", () => {
  test("uses the URL host (no slash → addressing stays intact)", () => {
    expect(CatalogSeed.providerIdForUrl(URL_A, "m")).toBe("192.168.178.40:8000")
    expect(CatalogSeed.providerIdForUrl(URL_B, "m")).toBe("api.other.test")
    expect(CatalogSeed.providerIdForUrl(URL_A, "m")).not.toContain("/")
  })
  test("falls back to the model id for a missing or malformed url", () => {
    expect(CatalogSeed.providerIdForUrl(undefined, "solo")).toBe("solo")
    expect(CatalogSeed.providerIdForUrl("not a url", "solo")).toBe("solo")
  })
})

describe("expandFlatModels", () => {
  test("configs without a flat models map pass through untouched", () => {
    const nested = { providers: { p: { api: { type: "native", settings: {} }, models: { chat: {} } } } }
    expect(CatalogSeed.expandFlatModels(nested)).toBe(nested)
  })

  test("groups flat models by endpoint host and expands the bare default", () => {
    const flat = {
      model: "qwen",
      models: {
        qwen: { name: "Qwen", url: URL_A, tier: "small", request: { body: { temperature: 0.7 } } },
        "qwen-fp8": { name: "Qwen FP8", url: URL_A },
        other: { name: "Other", url: URL_B },
      },
    }
    const expanded = CatalogSeed.expandFlatModels(flat) as Record<string, unknown>
    // two hosts → two providers; same-host models share a provider; url → openai-compatible api;
    // tier rides through onto the model; default expanded to host/id.
    expect(expanded).toEqual({
      model: "192.168.178.40:8000/qwen",
      providers: {
        "192.168.178.40:8000": {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: URL_A },
          models: {
            qwen: { name: "Qwen", tier: "small", request: { body: { temperature: 0.7 } } },
            "qwen-fp8": { name: "Qwen FP8" },
          },
        },
        "api.other.test": {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: URL_B },
          models: { other: { name: "Other" } },
        },
      },
    })
  })

  test("EQUIVALENCE GATE — flat and hand-authored nested decode to the same providers + default", () => {
    const flat = {
      model: "qwen",
      models: {
        qwen: {
          name: "Qwen",
          url: URL_A,
          tier: "small",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          request: { body: { temperature: 0.7, top_p: 0.8 } },
          variants: [{ id: "high", body: { reasoning_effort: "high" } }],
          limit: { context: 262144, output: 32768 },
        },
      },
    }
    const nested = {
      model: "192.168.178.40:8000/qwen",
      providers: {
        "192.168.178.40:8000": {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: URL_A },
          models: {
            qwen: {
              name: "Qwen",
              tier: "small",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              request: { body: { temperature: 0.7, top_p: 0.8 } },
              variants: [{ id: "high", body: { reasoning_effort: "high" } }],
              limit: { context: 262144, output: 32768 },
            },
          },
        },
      },
    }
    const fromFlat = decode(CatalogSeed.expandFlatModels(flat))
    const fromNested = decode(nested)
    expect(fromFlat.providers).toEqual(fromNested.providers)
    expect(fromFlat.model).toBe(fromNested.model)
    expect(fromFlat.model).toBe("192.168.178.40:8000/qwen")
  })

  test("merges flat models into a hand-authored provider of the same id", () => {
    const mixed = {
      providers: { "192.168.178.40:8000": { name: "Spark", models: { existing: { name: "Existing" } } } },
      models: { qwen: { name: "Qwen", url: URL_A } },
    }
    const expanded = CatalogSeed.expandFlatModels(mixed) as { providers: Record<string, { models: object }> }
    expect(Object.keys(expanded.providers["192.168.178.40:8000"].models)).toEqual(["existing", "qwen"])
  })
})
