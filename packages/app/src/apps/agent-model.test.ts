import { describe, expect, test } from "bun:test"
import { modelRef, parseModelRef } from "./agent-model"

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
    for (const bad of [undefined, "", "/", "holo3.1", "spark-holo/"])
      expect(parseModelRef(bad as never)).toBeUndefined()
  })
})
