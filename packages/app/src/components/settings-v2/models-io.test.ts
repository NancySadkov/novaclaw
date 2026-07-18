import { describe, expect, test } from "bun:test"
import { sanitizeModelBundle } from "./models-io"

// T12: secrets never travel in a model bundle — key/token/authorization-shaped fields and whole
// `headers` objects are stripped at every depth, on export AND re-checked on import.

describe("sanitizeModelBundle", () => {
  test("strips secret-named fields and headers objects at every depth", () => {
    const input = {
      "dgx-spark": {
        name: "DGX Spark",
        api: {
          type: "native",
          url: "http://spark:8000/v1",
          settings: { apiKey: "sk-secret", timeout: 30, authToken: "t", region: "local" },
        },
        request: { headers: { authorization: "Bearer x" }, body: { top_p: 0.8 } },
        models: {
          qwen: {
            name: "Qwen",
            request: { headers: { "x-api-key": "k" }, body: { temperature: 0.7 } },
            limit: { context: 262144 },
          },
        },
      },
    }
    const out = sanitizeModelBundle(input) as any
    const provider = out["dgx-spark"]
    expect(provider.api.url).toBe("http://spark:8000/v1")
    expect(provider.api.settings.timeout).toBe(30)
    expect(provider.api.settings.region).toBe("local")
    expect(provider.api.settings.apiKey).toBeUndefined()
    expect(provider.api.settings.authToken).toBeUndefined()
    expect(provider.request.headers).toBeUndefined()
    expect(provider.request.body.top_p).toBe(0.8)
    expect(provider.models.qwen.request.headers).toBeUndefined()
    expect(provider.models.qwen.request.body.temperature).toBe(0.7)
    expect(provider.models.qwen.limit.context).toBe(262144)
  })

  test("passes primitives and arrays through untouched", () => {
    expect(sanitizeModelBundle("x")).toBe("x")
    expect(sanitizeModelBundle([1, { password: "p", ok: true }])).toEqual([1, { ok: true }])
    expect(sanitizeModelBundle(null)).toBeNull()
  })
})
