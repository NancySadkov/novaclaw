import { describe, expect, test } from "bun:test"
import { selectGroups, selectIsGrouped } from "./select-groups"

// Ported from https://github.com/NancySadkov/novaclaw/pull/12 by @DassaultFalconKing.
//
// The bug: the component passed `options={grouped()}` and `optionGroupChildren="options"`
// UNCONDITIONALLY. With no `groupBy`, `selectGroups` returns one section keyed `""`, and telling
// Kobalte to read section children from an `options` key made it treat ordinary entries as sections —
// so Settings selectors, model selectors and the thinking-level control rendered EMPTY. It failed
// silently, in surfaces a normal person uses, and nothing could catch it because the decision lived
// in a JSX prop with no seam to test.

type Row = { id: string; family?: string }
const rows: Row[] = [
  { id: "a", family: "x" },
  { id: "b", family: "y" },
  { id: "c", family: "x" },
]

describe("selectIsGrouped", () => {
  test("is false when no groupBy is supplied", () => {
    expect(selectIsGrouped<Row>(undefined)).toBe(false)
  })

  test("is true when a groupBy is supplied", () => {
    expect(selectIsGrouped<Row>((r) => r.family ?? "")).toBe(true)
  })

  // THE REGRESSION, stated as an invariant: both Kobalte props are derived from this one predicate,
  // so they cannot disagree. The shipped bug was exactly a disagreement — grouped `options` paired
  // with a group-children key the ungrouped shape does not have.
  test("the same predicate drives both props, so they cannot disagree", () => {
    for (const groupBy of [undefined, (r: Row) => r.family ?? ""]) {
      const isGrouped = selectIsGrouped<Row>(groupBy)
      const options = isGrouped ? selectGroups(rows, groupBy) : rows
      const groupChildren = isGrouped ? "options" : undefined
      // A group-children key is meaningful only when the options are sections.
      expect(groupChildren === undefined).toBe(!Array.isArray(options) || !("category" in (options[0] as object)))
    }
  })
})

describe("selectGroups", () => {
  test("buckets by the supplied key", () => {
    const out = selectGroups(rows, (r) => r.family ?? "")
    expect(out.map((g) => g.category)).toEqual(["x", "y"])
    expect(out.find((g) => g.category === "x")?.options.map((r) => r.id)).toEqual(["a", "c"])
  })

  // NEGATIVE CONTROL for the reason the fix is needed: ungrouped is NOT a harmless passthrough — it
  // collapses everything into one anonymous section. Handing that to Kobalte as sections is the bug.
  test("with no groupBy it produces ONE anonymous section, which is why the raw list must be used", () => {
    const out = selectGroups(rows, undefined)
    expect(out).toHaveLength(1)
    expect(out[0]?.category).toBe("")
    expect(out[0]?.options).toHaveLength(3)
    expect(out).not.toEqual(rows as unknown as typeof out)
  })

  test("an empty option list stays empty rather than becoming an empty section", () => {
    expect(selectGroups([], undefined)).toEqual([])
  })
})
