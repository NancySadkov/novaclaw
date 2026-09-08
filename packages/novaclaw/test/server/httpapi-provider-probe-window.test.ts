import { describe, expect, test } from "bun:test"
import {
  discoveredModelLimits,
  modelContextWindow,
  modelOutputLimit,
  sharedContextWindow,
} from "@/server/routes/instance/httpapi/handlers/provider"

describe("provider probe context-window discovery", () => {
  test("reads vLLM, generic compatible, and llama.cpp metadata", () => {
    expect(modelContextWindow({ id: "vllm", max_model_len: 65_536 })).toBe(65_536)
    expect(modelContextWindow({ id: "generic", context_length: 49_152 })).toBe(49_152)
    expect(modelContextWindow({ id: "llama", meta: { n_ctx: 131_072 } })).toBe(131_072)
  })

  test("rejects malformed or non-positive windows", () => {
    expect(modelContextWindow({ max_model_len: 0, meta: { n_ctx: "32768" } })).toBeUndefined()
    expect(modelContextWindow({ context_length: 1.5 })).toBeUndefined()
  })

  test("keeps advertised context and completion limits attached to each model", () => {
    expect(
      discoveredModelLimits([
        { id: "deepseek", context_length: 262_144, max_completion_tokens: 32_768 },
        { id: "small", max_model_len: 65_536, max_output_tokens: 8_192 },
        { id: "silent" },
      ]),
    ).toEqual({
      deepseek: { context: 262_144, output: 32_768 },
      small: { context: 65_536, output: 8_192 },
    })
  })

  test("rejects malformed output limits instead of presenting them as server facts", () => {
    expect(modelOutputLimit({ max_completion_tokens: 0 })).toBeUndefined()
    expect(modelOutputLimit({ max_completion_tokens: "32768" })).toBeUndefined()
    expect(modelOutputLimit({ outputTokenLimit: 16_384 })).toBe(16_384)
  })

  test("reports a discovery-wide window only when every model agrees", () => {
    expect(sharedContextWindow([{ max_model_len: 32_768 }, { meta: { n_ctx: 32_768 } }])).toBe(32_768)
    expect(sharedContextWindow([{ max_model_len: 32_768 }, { max_model_len: 65_536 }])).toBeUndefined()
    expect(sharedContextWindow([{ max_model_len: 32_768 }, {}])).toBeUndefined()
  })
})
