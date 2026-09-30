import { describe, expect, test } from "bun:test"
import { Recipe } from "@novaclaw/core/recipe"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"

/**
 * Every key a `sparkrun` profile carries, taken from the real files: `notes/ops/sparkrun-*.yaml` in the
 * plan repo (`gemma-4-26b-q6`, `showui-2b-awq-grounding`) and `doc/spark.md`'s worked examples.
 *
 * Widening this list is always safe. Narrowing it needs a reason, because each member is a way for a
 * launch configuration to arrive wearing the word "recipe".
 */
const RUNTIME_PROFILE_KEYS = [
  "runtime",
  "container",
  "command",
  "env",
  "defaults",
  "model",
  "port",
  "host",
  "max_model_len",
  "max_num_batched_tokens",
  "max_num_seqs",
  "gpu_memory_utilization",
  "n_gpu_layers",
  "solo_only",
  "cluster_only",
  "min_nodes",
  "max_nodes",
  "recipe_version",
  "metadata",
] as const

/** What a bundled entry may carry, in full: `Recipe.SaveInput` plus the two `Builtin` requires. */
const ALLOWED_KEYS = ["slug", "name", "description", "prompt", "needs", "produces", "builtin"]

describe("a bundled recipe is not a Spark runtime profile", () => {
  test("the fixture is real (negative control): a sparkrun profile's keys are NONE of a recipe's", () => {
    expect(RUNTIME_PROFILE_KEYS.length).toBeGreaterThan(15)
    for (const key of RUNTIME_PROFILE_KEYS) expect(ALLOWED_KEYS).not.toContain(key)
  })

  test("no bundled entry carries a runtime-profile field", () => {
    for (const builtin of RecipeBuiltin.BUILTINS) {
      const keys = Object.keys(builtin)
      for (const forbidden of RUNTIME_PROFILE_KEYS) expect(keys).not.toContain(forbidden)
      // The positive half: the key set is CLOSED, so a new field has to be argued rather than added.
      for (const key of keys) expect(ALLOWED_KEYS).toContain(key)
    }
  })

  test("a collection is a SHELF — an id, a title, a sentence, and no knobs", () => {
    for (const collection of RecipeBuiltin.COLLECTIONS) {
      expect(Object.keys(collection).sort()).toEqual(["id", "note", "title"])
      expect(collection.title.trim().length).toBeGreaterThan(0)
      expect(collection.note.trim().length).toBeGreaterThan(0)
      for (const forbidden of RUNTIME_PROFILE_KEYS) expect(Object.keys(collection)).not.toContain(forbidden)
    }
  })

  test("no bundled PROMPT reads as a launch configuration either", () => {
    // The other direction the two could merge: a recipe whose prose is a `sparkrun` invocation would be a
    // runtime profile with extra steps. The bundled set is the install's health check, so it exercises the
    // host's own toolchain and never the model fleet.
    for (const builtin of RecipeBuiltin.BUILTINS) {
      expect(builtin.prompt).not.toContain("sparkrun")
      expect(builtin.prompt).not.toContain("gpu_memory_utilization")
      expect(builtin.prompt).not.toContain("vllm")
    }
  })
})

describe("collection membership is decided by the BUILD", () => {
  test("every bundled slug is on the Examples shelf, and nothing else is", () => {
    expect(RecipeBuiltin.BUILTINS.length).toBeGreaterThan(5) // negative control
    for (const builtin of RecipeBuiltin.BUILTINS) expect(RecipeBuiltin.collectionOf(builtin.slug)).toBe("examples")
    for (const mine of ["my-recipe", "hello-c-2", "", "install-health-check-copy"])
      expect(RecipeBuiltin.collectionOf(mine)).toBe("mine")
  })

  test("a recipe cannot DECLARE its way onto the Examples shelf", () => {
    const hostile = JSON.stringify({
      version: 1,
      name: "Trojan",
      collection: "examples",
      builtin: true,
      prompt: "Do it",
    })
    const parsed = Recipe.parse(hostile)
    expect(parsed.collection).toBe("examples")
    expect(RecipeBuiltin.collectionOf("trojan")).toBe("mine")
    expect(RecipeBuiltin.collectionOf("examples/hello-c")).toBe("mine")
    expect(Recipe.parse(Recipe.render(parsed)).collection).toBe("examples")
  })

  test("editing a shipped example keeps it on the Examples shelf — they own the bytes, not the provenance", () => {
    expect(RecipeBuiltin.collectionOf("hello-c")).toBe("examples")
  })
})
