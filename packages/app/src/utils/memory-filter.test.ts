import { describe, expect, test } from "bun:test"
import {
  defaultFilter,
  describeScope,
  isNarrowed,
  matches,
  matchesQuery,
  toggleKind,
  type MemoryFilter,
} from "./memory-filter"

const row = (name: string | null, text: string, kind = "entity") => ({ name, text, kind })

describe("matchesQuery", () => {
  test("empty query matches everything — never nothing", () => {
    expect(matchesQuery(row("Nancy", "wrote Symta"), "")).toBe(true)
    expect(matchesQuery(row("Nancy", "wrote Symta"), "   ")).toBe(true)
  })

  test("matches the NAME and the TEXT, case-insensitively", () => {
    expect(matchesQuery(row("Nancy", "wrote Symta"), "nancy")).toBe(true)
    expect(matchesQuery(row("Nancy", "wrote Symta"), "SYMTA")).toBe(true)
    expect(matchesQuery(row("Nancy", "wrote Symta"), "kotlin")).toBe(false)
  })

  test("a nameless memory is searched by its text alone, without throwing", () => {
    expect(matchesQuery(row(null, "something happened"), "happened")).toBe(true)
    expect(matchesQuery(row(null, ""), "anything")).toBe(false)
  })

  test("🔴 every term must appear — extra words NARROW, they never widen", () => {
    // OR would make each typed word grow the result set, and the control would feel broken.
    expect(matchesQuery(row("Widget Manual", "rotor calibration"), "widget rotor")).toBe(true)
    expect(matchesQuery(row("Widget Manual", "rotor calibration"), "widget dragon")).toBe(false)
  })

  test("a term may span the name/text boundary only as separate terms, not as one string", () => {
    // The two fields are joined by a newline precisely so a query cannot accidentally match across
    // them as a phrase — "Nancy wrote" is two terms, and both are found; "Nancywrote" is neither.
    expect(matchesQuery(row("Nancy", "wrote Symta"), "nancy wrote")).toBe(true)
    expect(matchesQuery(row("Nancy", "wrote Symta"), "nancywrote")).toBe(false)
  })
})

describe("matches", () => {
  const filter = defaultFilter()

  test("kind gates before text — a hidden kind never matches, however well it reads", () => {
    expect(matches(row("Chapter 1", "rotor", "passage"), { ...filter, query: "rotor" })).toBe(false)
    expect(matches(row("Chapter 1", "rotor", "entity"), { ...filter, query: "rotor" })).toBe(true)
  })

  test("an EMPTY kind set admits nothing THE CHIPS NAME — a state they can genuinely reach", () => {
    const none: MemoryFilter = { ...filter, kinds: new Set() }
    expect(matches(row("Nancy", "anything"), none)).toBe(false)
  })

  test("🔴 a kind with NO CHIP is never hidden — `claim` was invisible in the Remembered list", () => {
    // The store's first-class unit of memory has no chip yet (the chips are the Map's three
    // shapes), and `kinds.has(row.kind)` hid every claim from the surface whose entire job is
    // answering "what do you remember" — with no control on screen that could have brought them
    // back. A control that does not exist cannot be switched off by the user, so it must not be
    // switched off on their behalf.
    expect(matches(row("Ann", "Ann works at Acme", "claim"), filter)).toBe(true)
    expect(matches(row("Ann", "Ann works at Acme", "claim"), { ...filter, kinds: new Set() })).toBe(true)
    // ...and it still obeys every filter that DOES apply to it
    expect(matches(row("Ann", "Ann works at Acme", "claim"), { ...filter, query: "kotlin" })).toBe(false)
    expect(matches({ ...row("Ann", "x", "claim"), status: "archived" }, filter)).toBe(false)
  })

  test("🔴 the LENS is real — `Current` rejects a corrected claim, `History` admits it", () => {
    // This field was INERT: `matches()` ignored it, so the header's toggle changed its own label and
    // nothing else. If this test ever goes green with the lens check deleted, the control is a lie
    // again.
    const corrected = { ...row("Ann", "Ann works at Initech"), status: "superseded" }
    expect(matches(corrected, filter)).toBe(false)
    expect(matches(corrected, { ...filter, lens: "history" })).toBe(true)
    expect(matches({ ...corrected, status: "active" }, filter)).toBe(true)
  })

  test("a row with no status at all still passes — a filter narrows, it does not erase", () => {
    expect(matches(row("Ann", "Ann works at Acme"), filter)).toBe(true)
  })
})

describe("isNarrowed", () => {
  test("the default is not narrowed", () => {
    expect(isNarrowed(defaultFilter())).toBe(false)
  })

  test("a query, a LENS change, or a kind change all count", () => {
    expect(isNarrowed({ ...defaultFilter(), query: "x" })).toBe(true)
    expect(isNarrowed({ ...defaultFilter(), lens: "history" })).toBe(true)
    expect(isNarrowed(toggleKind(defaultFilter(), "passage"))).toBe(true)
    expect(isNarrowed(toggleKind(defaultFilter(), "entity"))).toBe(true)
  })
})

describe("toggleKind", () => {
  test("adds, removes, and never mutates the original", () => {
    const base = defaultFilter()
    const withPassages = toggleKind(base, "passage")
    expect(withPassages.kinds.has("passage")).toBe(true)
    expect(base.kinds.has("passage")).toBe(false)
    expect(toggleKind(withPassages, "passage").kinds.has("passage")).toBe(false)
  })
})

describe("describeScope", () => {
  test("🔴 a partial load SAYS what it searched", () => {
    // "No matches" over 600 of 706 is the empty cabinet in a new costume: true of what was searched,
    // false as an answer to the question that was asked.
    expect(describeScope({ loaded: 600, total: 706 })).toBe("Searched the 600 loaded here, not all 706.")
  })

  test("a complete load says nothing — a notice with nothing to warn about is noise", () => {
    expect(describeScope({ loaded: 706, total: 706 })).toBeUndefined()
    expect(describeScope({ loaded: 800, total: 706 })).toBeUndefined()
  })

  test("an unknown total says nothing rather than guessing", () => {
    expect(describeScope({ loaded: 10, total: undefined })).toBeUndefined()
  })
})
