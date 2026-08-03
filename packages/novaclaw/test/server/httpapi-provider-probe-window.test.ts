import { describe, expect, test } from "bun:test"
import {
  modelContextWindow,
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

  test("reports a discovery-wide window only when every model agrees", () => {
    expect(sharedContextWindow([{ max_model_len: 32_768 }, { meta: { n_ctx: 32_768 } }])).toBe(32_768)
    expect(sharedContextWindow([{ max_model_len: 32_768 }, { max_model_len: 65_536 }])).toBeUndefined()
    expect(sharedContextWindow([{ max_model_len: 32_768 }, {}])).toBeUndefined()
  })
})
