import { describe, expect, test } from "bun:test"
import { briefTooBigForTier, isTier, modelRef, parseModelRef } from "./agent-model"

describe("how a colleague's model is written down", () => {
  // The key is `id`, not `modelID`. It used to be `modelID` here and `id` in the runner's identical
  // parser, so neither result could be handed to the other's consumers and every call site in this
  // package renamed the field on the way in. One parser, one key, in @novaclaw/schema beside Model.Ref.
  test("round-trips provider and model", () => {
    expect(modelRef({ providerID: "spark-holo", id: "holo3.1" })).toBe("spark-holo/holo3.1")
    expect(parseModelRef("spark-holo/holo3.1")).toEqual({ providerID: "spark-holo", id: "holo3.1" })
  })

  test("a model id containing a slash still parses on the FIRST slash", () => {
    // Provider ids do not contain slashes; model ids can ("org/name" on some hubs). Splitting on the
    // last one would put half the model id in the provider.
    expect(parseModelRef("hf/meta-llama/Llama-3")).toEqual({ providerID: "hf", id: "meta-llama/Llama-3" })
  })

  test("a malformed ref is undefined rather than half-parsed", () => {
    // "inherit the instance default" is the meaning of an absent model, so a broken value must fall
    // back to it rather than address a provider that does not exist.
    for (const bad of [undefined, "", "/", "holo3.1", "spark-holo/"]) expect(parseModelRef(bad as never)).toBeUndefined()
  })

  test("tiers are recognised, and anything else is not", () => {
    expect(isTier("micro")).toBe(true)
    expect(isTier("frontier")).toBe(true)
    expect(isTier("enormous")).toBe(false)
  })
})

describe("is the brief bigger than the mind", () => {
  const long = "x".repeat(2_000)
  const veryLong = "x".repeat(5_000)

  test("no tier, no opinion — silence is not a warning", () => {
    // Inventing a warning from an unknown model would teach the user to ignore the ones that mean
    // something.
    expect(briefTooBigForTier({ brief: veryLong, personality: undefined, tier: undefined })).toBeUndefined()
  })

  test("a floor-tier model with a long standing brief is flagged", () => {
    expect(briefTooBigForTier({ brief: long, personality: undefined, tier: "tiny" })).toBe(true)
    expect(briefTooBigForTier({ brief: long, personality: undefined, tier: "micro" })).toBe(true)
  })

  test("a small model tolerates more before it is flagged", () => {
    expect(briefTooBigForTier({ brief: long, personality: undefined, tier: "small" })).toBe(false)
    expect(briefTooBigForTier({ brief: veryLong, personality: undefined, tier: "small" })).toBe(true)
  })

  test("a capable model is never flagged for a long brief", () => {
    for (const tier of ["medium", "large", "frontier"] as const)
      expect(briefTooBigForTier({ brief: veryLong, personality: veryLong, tier })).toBe(false)
  })

  test("a colleague with no brief is never flagged", () => {
    // Nothing has been asked of it yet; warning would be a comment on an empty page.
    expect(briefTooBigForTier({ brief: undefined, personality: undefined, tier: "micro" })).toBe(false)
    expect(briefTooBigForTier({ brief: "   ", personality: "  ", tier: "micro" })).toBe(false)
  })

  test("the brief and the personality count TOGETHER", () => {
    // They are both standing instruction — the model reads them in the same window, so splitting the
    // budget between them would let a colleague sneak past the check in two halves.
    const half = "x".repeat(900)
    expect(briefTooBigForTier({ brief: half, personality: half, tier: "tiny" })).toBe(true)
  })
})
