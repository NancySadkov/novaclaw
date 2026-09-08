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

  describe("🔴 an essential tool cannot be routed away", () => {
    // The self-healing law (AGENTS.md): as long as one working model remains, the instance must be
    // restorable by ASKING an agent. `tool_routing` is an arbitrary {name: false} map an agent can
    // write with one `configure` card — so without a floor, one write removes the write path and
    // nothing inside the instance can undo it. That is the single config change that cannot be
    // repaired by the mechanism the law names.
    test("a direct rule against it does not take", () => {
      const offered = ConfigToolRouting.offered(decode({ rules: [{ tools: { configure: false } }] }), target)
      expect(offered("configure")).toBe(true)
    })

    test("nor a broad rule, nor the last word in an ordered table", () => {
      const offered = ConfigToolRouting.offered(
        decode({
          rules: [
            { tools: { configure: true, read: true } },
            { provider: "dgx", tools: { configure: false } },
            { mode: "bypass", tools: { configure: false, read: false } },
          ],
        }),
        target,
      )
      expect(offered("configure")).toBe(true)
      // …and the floor is NARROW: everything else still obeys the table, or this would be a
      // routing table that does nothing rather than a protected tool.
      expect(offered("read")).toBe(false)
    })

    test("the guard is not vacuous — the same table disables a non-essential tool by the same route", () => {
      // The negative control. If `offered` stopped honouring `false` at all, every assertion above
      // would pass for the wrong reason.
      const offered = ConfigToolRouting.offered(decode({ rules: [{ tools: { bash: false } }] }), target)
      expect(offered("bash")).toBe(false)
      expect(ConfigToolRouting.ESSENTIAL_TOOLS.has("bash")).toBe(false)
      expect(ConfigToolRouting.ESSENTIAL_TOOLS.has("configure")).toBe(true)
    })
  })

  test("the schema refuses invented modes and non-boolean tool decisions", () => {
    expect(() => decode({ rules: [{ mode: "root", tools: { bash: false } }] })).toThrow()
    expect(() => decode({ rules: [{ tools: { bash: "off" } }] })).toThrow()
  })
})
