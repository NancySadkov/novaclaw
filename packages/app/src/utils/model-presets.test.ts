import { describe, expect, test } from "bun:test"
import { matchPreset } from "./model-presets"

describe("model sampling presets", () => {
  test("recognizes the qwen family case-insensitively, including pathed ids", () => {
    expect(matchPreset("qwen3.6-35b")?.family).toBe("qwen")
    expect(matchPreset("Qwen/Qwen3.6-35B-A3B-FP8")?.family).toBe("qwen")
    expect(matchPreset("qwen3.6-35b")?.body).toMatchObject({ temperature: 0.7, top_p: 0.8, top_k: 20 })
  })

  test("more specific families win over substring cousins", () => {
    // "gpt-oss" must not fall through to another family, and its recommendation is flat sampling.
    expect(matchPreset("openai/gpt-oss-120b")).toEqual({
      family: "gpt-oss",
      body: { temperature: 1.0, top_p: 1.0 },
    })
  })

  test("covers the documented families", () => {
    expect(matchPreset("deepseek-r1-distill")?.body).toMatchObject({ temperature: 0.6, top_p: 0.95 })
    expect(matchPreset("Meta-Llama-3.3-70B-Instruct")?.family).toBe("llama")
    expect(matchPreset("gemma-3-27b-it")?.body).toMatchObject({ top_k: 64 })
    expect(matchPreset("GLM-4.6")?.family).toBe("glm")
    expect(matchPreset("Kimi-K2-Instruct")?.body).toEqual({ temperature: 0.6 })
  })

  test("unknown ids get no preset", () => {
    expect(matchPreset("mystery-model-9000")).toBeUndefined()
    expect(matchPreset("")).toBeUndefined()
  })
})
