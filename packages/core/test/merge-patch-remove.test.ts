import { describe, expect, test } from "bun:test"
import { MergePatch } from "@novaclaw/core/merge-patch"

/**
 * `MergePatch.removeAt` — the pure half of v0.2.0 item 4.3's deletion verb.
 *
 * The ruling it implements is recorded at the top of `merge-patch.ts`: **`null` is a value, never a
 * tombstone**, so removal is addressed by PATH. These tests pin the three properties the callers
 * lean on — structural (no mutation), honest (`undefined` means the path named nothing, which every
 * caller turns into a named refusal), and array-refusing.
 */
describe("MergePatch.removeAt", () => {
  test("removes a top-level key and leaves the rest", () => {
    expect(MergePatch.removeAt({ a: 1, b: 2 }, ["a"])).toEqual({ value: { b: 2 } })
  })

  test("removes a nested key without disturbing its siblings or ancestors", () => {
    const base = { mcp: { timeout: { startup: 5 }, servers: { keep: { type: "local" }, drop: { type: "local" } } } }
    expect(MergePatch.removeAt(base, ["mcp", "servers", "drop"])).toEqual({
      value: { mcp: { timeout: { startup: 5 }, servers: { keep: { type: "local" } } } },
    })
  })

  test("does not mutate the input — the caller may still need the pre-removal value", () => {
    const base = { a: { b: 1, c: 2 } }
    const result = MergePatch.removeAt(base, ["a", "b"])
    expect(result).toEqual({ value: { a: { c: 2 } } })
    expect(base).toEqual({ a: { b: 1, c: 2 } })
  })

  /**
   * The whole reason the return type is optional rather than a plain value. A caller that cannot
   * tell "removed" from "was never there" has to report success either way — the
   * failed-mutation-reports-success shape todo.md ruling 2 forbids.
   */
  test("a path that names nothing yields undefined, at every depth", () => {
    expect(MergePatch.removeAt({ a: 1 }, ["b"])).toBeUndefined()
    expect(MergePatch.removeAt({ a: { b: 1 } }, ["a", "c"])).toBeUndefined()
    expect(MergePatch.removeAt({ a: { b: 1 } }, ["a", "b", "c"])).toBeUndefined()
    expect(MergePatch.removeAt({ a: 1 }, [])).toBeUndefined()
    expect(MergePatch.removeAt(undefined, ["a"])).toBeUndefined()
    expect(MergePatch.removeAt(null, ["a"])).toBeUndefined()
  })

  /** A key holding an explicit `null` still EXISTS and is therefore removable — the exact case the
   *  RFC-7396 tombstone reading cannot distinguish, and the reason this design does not use it. */
  test("removes a key whose value is null", () => {
    expect(MergePatch.removeAt({ a: null, b: 1 }, ["a"])).toEqual({ value: { b: 1 } })
  })

  /**
   * Arrays replace wholesale under the merge contract, so `PATCH /config` already deletes an entry
   * by re-sending the list without it (commit 53051cca8 ruled on this). An index segment here would
   * be a second way to do that, with an off-by-one attached.
   */
  test("refuses to index or descend into an array", () => {
    expect(MergePatch.removeAt({ skills: ["a", "b"] }, ["skills", "0"])).toBeUndefined()
    expect(MergePatch.removeAt({ skills: ["a", "b"] }, ["skills", "0", "x"])).toBeUndefined()
    // The array-valued KEY itself is still removable — it is the indexing that is refused.
    expect(MergePatch.removeAt({ skills: ["a"], keep: 1 }, ["skills"])).toEqual({ value: { keep: 1 } })
  })

  /**
   * ⚠️ The trap a dotted path syntax would have walked into. `holo3.1` is a real model id in this
   * instance's catalog and it contains the separator; ids with slashes (`openai/gpt-oss-120b`) are
   * just as common. A segment array needs no escaping and cannot mis-target.
   */
  test("segments carrying dots, slashes and colons address exactly one key", () => {
    const base = {
      providers: {
        "spark-holo": {
          models: { "holo3.1": { name: "Holo" }, "hf.co/unsloth/Qwen3.6:UD-Q4": { name: "Qwen" } },
        },
      },
    }
    expect(MergePatch.removeAt(base, ["providers", "spark-holo", "models", "holo3.1"])).toEqual({
      value: { providers: { "spark-holo": { models: { "hf.co/unsloth/Qwen3.6:UD-Q4": { name: "Qwen" } } } } },
    })
    // The negative control for the same trap: the dot-joined spelling is not a key and names nothing.
    expect(MergePatch.removeAt(base, ["providers.spark-holo.models.holo3.1"])).toBeUndefined()
  })

  test("showPath quotes each segment so an id with a separator is legible in an error", () => {
    expect(MergePatch.showPath(["providers", "spark-holo", "models", "holo3.1"])).toBe(
      '"providers" → "spark-holo" → "models" → "holo3.1"',
    )
  })
})
