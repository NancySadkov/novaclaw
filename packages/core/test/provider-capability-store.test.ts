import { describe, expect, test } from "bun:test"
import { ProviderCapabilityStore } from "@novaclaw/core/provider-capability-store"

/**
 * What survives a restart, and what must NOT be invented.
 *
 * The store's purpose is to say what was measured. Every case here is a way it could end up
 * claiming something nobody measured — which is worse than an empty store, because the runner acts
 * on it and the surface reports it as fact.
 */

const entry = { choice: "prompted" as const, rationale: "native dropped an argument", measuredAt: 1_700_000_000_000 }

describe("decoding what was stored", () => {
  test("a well-formed map round-trips", () => {
    expect(ProviderCapabilityStore.decodeAll({ fp: entry })).toEqual({ fp: entry })
  })

  test("🔴 a corrupt row is DROPPED, never repaired into a default", () => {
    // Repairing it to `native` would be a claim nobody made, and the runner would then take the
    // native rung on the strength of a parse failure. Absent is the only honest answer.
    const decoded = ProviderCapabilityStore.decodeAll({
      good: entry,
      noChoice: { rationale: "x", measuredAt: 1 },
      badChoice: { choice: "sometimes", measuredAt: 1 },
      noTime: { choice: "native", rationale: "x" },
      notAnObject: "native",
      nul: null,
    })
    expect(Object.keys(decoded)).toEqual(["good"])
  })

  test("a missing rationale degrades to empty rather than dropping the verdict", () => {
    // The choice is the load-bearing half; the sentence is for a surface to show. Losing the
    // sentence must not lose the measurement.
    const decoded = ProviderCapabilityStore.decodeAll({ fp: { choice: "chat-only", measuredAt: 5 } })
    expect(decoded["fp"]).toEqual({ choice: "chat-only", rationale: "", measuredAt: 5 })
  })

  test("nothing stored is an empty map, never a throw", () => {
    // Read on every model resolution; a throw here would take down turns to answer a question about
    // tool channels.
    expect(ProviderCapabilityStore.decodeAll(undefined)).toEqual({})
    expect(ProviderCapabilityStore.decodeAll(null)).toEqual({})
    expect(ProviderCapabilityStore.decodeAll("not a map")).toEqual({})
    expect(ProviderCapabilityStore.decodeAll([])).toEqual({})
  })

  test("`unknown` is a storable verdict — it is not the same as no entry", () => {
    // "We tried and could not find out" is worth remembering: it stops a surface claiming the
    // endpoint was never tested, and it is deliberately NOT a decision the runner acts on.
    const decoded = ProviderCapabilityStore.decodeAll({ fp: { choice: "unknown", rationale: "401", measuredAt: 9 } })
    expect(decoded["fp"]?.choice).toBe("unknown")
  })
})
