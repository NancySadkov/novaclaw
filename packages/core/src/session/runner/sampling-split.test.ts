import { describe, expect, test } from "bun:test"
import { splitModelSampling } from "./sampling-split"

describe("splitModelSampling", () => {
  test("routes protocol-owned sampling to generation, extras to http (the qwen config)", () => {
    const { generation, http } = splitModelSampling({
      min_p: 0,
      max_p: 0.95,
      top_p: 0.8,
      top_k: 20,
      temperature: 0.7,
      presence_penalty: 0,
      repetition_penalty: 1.05,
    })
    expect(generation).toEqual({ topP: 0.8, topK: 20, temperature: 0.7, presencePenalty: 0 })
    expect(http).toEqual({ min_p: 0, max_p: 0.95, repetition_penalty: 1.05 })
  })

  test("no protocol-owned field ends up in the http overlay", () => {
    const { http } = splitModelSampling({ temperature: 1, top_p: 1, top_k: 5, presence_penalty: 0, min_p: 0.01 })
    for (const forbidden of ["temperature", "top_p", "topP", "top_k", "topK", "presence_penalty"])
      expect(forbidden in http).toBe(false)
  })

  test("camelCase keys map too", () => {
    const { generation } = splitModelSampling({ topP: 0.9, maxOutputTokens: 1024, frequencyPenalty: 0.1 })
    expect(generation).toEqual({ topP: 0.9, maxTokens: 1024, frequencyPenalty: 0.1 })
  })

  test("undefined values are dropped", () => {
    const { generation, http } = splitModelSampling({ temperature: undefined, foo: undefined, bar: 1 })
    expect(generation).toEqual({})
    expect(http).toEqual({ bar: 1 })
  })

  test("empty body yields empty splits", () => {
    expect(splitModelSampling({})).toEqual({ generation: {}, http: {} })
  })
})
