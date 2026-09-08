import { describe, expect, test } from "bun:test"
import { ModelPrune } from "./model-prune"
import type { ConfigProvider } from "../config/provider"

// The fixtures mirror a real instance catalogue as it stood on 2026-08-06, slashed model ids and
// all -- those ids are the reason `refNamesModel` cannot use a plain destructuring split.
const layer = (models: Record<string, { name?: string }>): ConfigProvider.Info =>
  ({ name: "Spark", api: { url: "http://spark-0693.local:8010/v1" }, models }) as unknown as ConfigProvider.Info

describe("stripModel", () => {
  test("removes the named model and leaves its siblings untouched", () => {
    const out = ModelPrune.stripModel([layer({ "holo3.1": {}, "qwen3.6-35b": {} })], "qwen3.6-35b")
    expect(out).toBeDefined()
    expect(Object.keys(out![0].models ?? {})).toEqual(["holo3.1"])
  })

  test("strips from EVERY layer, not just the first one that matches", () => {
    // A model redeclared across layers is the normal shape here -- the fold merges them -- so
    // stopping at the first hit would leave the entry alive and the delete would look like a no-op
    // that reported success.
    const out = ModelPrune.stripModel([layer({ a: {}, dead: { name: "old" } }), layer({ dead: { name: "newer" } })], "dead")
    expect(out).toBeDefined()
    expect(Object.keys(out![0].models ?? {})).toEqual(["a"])
    expect(Object.keys(out![1].models ?? {})).toEqual([])
  })

  test("returns undefined when the model is in no layer, so the caller can 404 honestly", () => {
    expect(ModelPrune.stripModel([layer({ a: {} })], "not-here")).toBeUndefined()
  })

  test("a provider whose last model is stripped is KEPT, endpoint and all", () => {
    const out = ModelPrune.stripModel([layer({ only: {} })], "only")
    expect(out).toBeDefined()
    expect(out!.length).toBe(1)
    expect(Object.keys(out![0].models ?? {})).toEqual([])
    // The expensive hand-authored part survives; forgetting how to reach the host is a separate act.
    expect((out![0] as unknown as { api: { url: string } }).api.url).toBe("http://spark-0693.local:8010/v1")
  })

  test("an emptied layer is rewritten, never dropped — the fold is positional", () => {
    const out = ModelPrune.stripModel([layer({ dead: {} }), layer({ live: {} })], "dead")
    expect(out!.length).toBe(2)
  })

  test("a layer with no models map at all is passed through unchanged", () => {
    const bare = { name: "Spark" } as unknown as ConfigProvider.Info
    expect(ModelPrune.stripModel([bare], "anything")).toBeUndefined()
  })

  test("does not mutate the input", () => {
    const input = [layer({ a: {}, b: {} })]
    ModelPrune.stripModel(input, "a")
    expect(Object.keys(input[0].models ?? {}).sort()).toEqual(["a", "b"])
  })

  test("a model id containing slashes is matched exactly", () => {
    const id = "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL"
    const out = ModelPrune.stripModel([layer({ [id]: {}, other: {} })], id)
    expect(Object.keys(out![0].models ?? {})).toEqual(["other"])
  })
})

describe("refNamesModel splits on the FIRST slash only", () => {
  test("matches a plain ref", () => {
    expect(ModelPrune.refNamesModel("spark-holo/holo3.1", "spark-holo", "holo3.1")).toBe(true)
  })

  test("matches a ref whose MODEL id contains slashes", () => {
    // The trap: a naive split("/") destructure yields modelID "hf.co" here and would both fail to
    // match and, on a different pair, match the wrong model.
    const ref = "endpoint-a/hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL"
    expect(ModelPrune.refNamesModel(ref, "endpoint-a", "hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL")).toBe(true)
  })

  test("does not confuse two models that share a first segment", () => {
    expect(ModelPrune.refNamesModel("p/openai/a", "p", "openai/b")).toBe(false)
  })

  test("a different provider with the same model id does not match", () => {
    expect(ModelPrune.refNamesModel("spark-holo/holo3.1", "dgx-spark", "holo3.1")).toBe(false)
  })

  test("undefined, empty and slashless refs are all false rather than throwing", () => {
    expect(ModelPrune.refNamesModel(undefined, "p", "m")).toBe(false)
    expect(ModelPrune.refNamesModel("", "p", "m")).toBe(false)
    expect(ModelPrune.refNamesModel("nomodel", "nomodel", "")).toBe(false)
    expect(ModelPrune.refNamesModel("/leading", "", "leading")).toBe(false)
  })
})
