import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigToolRouting } from "./tool-routing"

const target = { mode: "bypass", providerID: "dgx-spark", modelID: "Qwen3.6-35B" } as const

const decode = (input: unknown) => Schema.decodeUnknownSync(ConfigToolRouting.Info)(input)

describe("per-model tool routing", () => {
  test("absent config preserves the existing tool horizon", () => {
    const offered = ConfigToolRouting.offered(undefined, target)
    expect(["read", "write", "apply_patch"].every(offered)).toBe(true)
  })

  test("selectors are conjunctive case-insensitive substrings and omitted selectors match all", () => {
    const offered = ConfigToolRouting.offered(
      decode({
        rules: [
          { provider: "DGX", tools: { read: false } },
          { provider: "spark", model: "qwen3.6", tools: { write: false } },
          { mode: "plan", tools: { apply_patch: false } },
          { model: "other", tools: { bash: false } },
        ],
      }),
      target,
    )

    expect(offered("read")).toBe(false)
    expect(offered("write")).toBe(false)
    expect(offered("apply_patch")).toBe(true)
    expect(offered("bash")).toBe(true)
  })

  test("later matching rules win per tool while unrelated decisions survive", () => {
    const offered = ConfigToolRouting.offered(
      decode({
        rules: [
          { tools: { read: false, write: false } },
          { model: "qwen", tools: { write: true, apply_patch: false } },
          { provider: "DGX-SPARK", tools: { apply_patch: true } },
        ],
      }),
      target,
    )

    expect(offered("read")).toBe(false)
    expect(offered("write")).toBe(true)
    expect(offered("apply_patch")).toBe(true)
    expect(offered("unmentioned")).toBe(true)
  })

  test("the schema refuses invented modes and non-boolean tool decisions", () => {
    expect(() => decode({ rules: [{ mode: "root", tools: { bash: false } }] })).toThrow()
    expect(() => decode({ rules: [{ tools: { bash: "off" } }] })).toThrow()
  })
})
