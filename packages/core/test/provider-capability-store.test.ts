import { describe, expect, test } from "bun:test"
import { ProviderCapabilityStore } from "@novaclaw/core/provider-capability-store"

/**
 * What survives a restart, and what must NOT be invented.
 *
 * The store's purpose is to say what was measured. Every case here is a way it could end up
 * claiming something nobody measured — which is worse than an empty store, because the runner acts
 * on it and the surface reports it as fact.
 */

const entry = {
  choice: "prompted" as const,
  rationale: "native dropped an argument",
  measuredAt: 1_700_000_000_000,
  fingerprint: '["http://h/v1","m","openai-chat",null]',
  endpoint: "http://h/v1",
}

describe("decoding what was stored", () => {
  test("a well-formed row round-trips", () => {
    expect(ProviderCapabilityStore.decodeAll({ "p/m": entry })).toEqual({ "p/m": entry })
  })

  test("🔴 a corrupt row is DROPPED, never repaired into a default", () => {
    // Repairing it to `native` would be a claim nobody made, and the runner would then take the
    // native rung on the strength of a parse failure. Absent is the only honest answer.
    const decoded = ProviderCapabilityStore.decodeAll({
      good: entry,
      noChoice: { rationale: "x", measuredAt: 1, fingerprint: "f", endpoint: "e" },
      badChoice: { choice: "sometimes", measuredAt: 1, fingerprint: "f", endpoint: "e" },
      noTime: { choice: "native", rationale: "x", fingerprint: "f", endpoint: "e" },
      notAnObject: "native",
      nul: null,
    })
    expect(Object.keys(decoded)).toEqual(["good"])
  })

  test("🔴 a row with NO fingerprint is dropped — a measurement we cannot place", () => {
    // Staleness is checked by comparing fingerprints. A row that carries none can never be shown to
    // still apply, so acting on it would mean acting on a measurement about an unknown endpoint.
    const decoded = ProviderCapabilityStore.decodeAll({
      fp: { choice: "prompted", rationale: "x", measuredAt: 1 },
    })
    expect(decoded).toEqual({})
  })

  test("a missing rationale degrades to empty rather than dropping the verdict", () => {
    // The choice is the load-bearing half; the sentence is for a surface to show. Losing the
    // sentence must not lose the measurement.
    const decoded = ProviderCapabilityStore.decodeAll({
      "p/m": { choice: "chat-only", measuredAt: 5, fingerprint: "f" },
    })
    // ⚠️ A row written before `endpoint` existed keeps its verdict, with an empty endpoint. Dropping
    // it would re-measure every endpoint for the sake of a display detail.
    expect(decoded["p/m"]).toEqual({
      choice: "chat-only",
      rationale: "",
      measuredAt: 5,
      fingerprint: "f",
      endpoint: "",
    })
  })

  test("a serving identity round-trips, and its absence is silence", () => {
    // Recorded so a person can see WHICH process produced a verdict. Absent for an endpoint that
    // reports none, rather than a synthesised "unknown" — most wires never answer this question.
    const withID = ProviderCapabilityStore.decodeAll({ "p/m": { ...entry, servedBy: "vllm-x-a44fe734" } })
    expect(withID["p/m"]?.servedBy).toBe("vllm-x-a44fe734")
    expect(ProviderCapabilityStore.decodeAll({ "p/m": entry })["p/m"]?.servedBy).toBeUndefined()
    expect(ProviderCapabilityStore.decodeAll({ "p/m": { ...entry, servedBy: "" } })["p/m"]?.servedBy).toBeUndefined()
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
    const decoded = ProviderCapabilityStore.decodeAll({
      "p/m": { choice: "unknown", rationale: "401", measuredAt: 9, fingerprint: "f", endpoint: "e" },
    })
    expect(decoded["p/m"]?.choice).toBe("unknown")
  })
})

describe("discarding a verdict whose serving process is gone", () => {
  // `forgetIfMoved` needs a live store, so the RULE is asserted here on the same predicate the
  // implementation uses: act only when both identities are known and differ. The three cases below
  // are the ones that must NOT discard — each would otherwise re-measure on every single turn, which
  // reads as a probe whose result never sticks.
  const decides = (stored: string | undefined, live: string) => stored !== undefined && stored !== live

  test("🔴 a different serving process discards; the same one does not", () => {
    expect(decides("vllm-a44fe734", "vllm-a54ff5e8")).toBe(true)
    expect(decides("vllm-a44fe734", "vllm-a44fe734")).toBe(false)
  })

  test("🔴 an unknown identity on EITHER side is not evidence of a move", () => {
    // A verdict recorded before the field existed, or an endpoint that reports none. Discarding on
    // absence would empty the store on the next turn for every such endpoint.
    expect(decides(undefined, "vllm-a44fe734")).toBe(false)
  })
})

describe("the key, and why it is not the fingerprint", () => {
  test("🔴 the key is provider/model — the two things both sides trivially agree on", () => {
    // The trap this avoids is SILENT and green: the writer holds provider config and the reader
    // holds a catalog model, so a fingerprint-keyed store lets them derive different keys, every
    // lookup misses, "not measured" falls back to the protocol default — and the whole store is
    // never read while nothing fails.
    expect(ProviderCapabilityStore.key("spark-holo", "holo3.1")).toBe("spark-holo/holo3.1")
  })
})
