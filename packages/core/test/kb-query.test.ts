import { describe, expect, test } from "bun:test"
import { KbQuery } from "@novaclaw/core/kb-query"

// KB-E phase 1 — the pure six-op query engine over a rockfacts-style fixture.
// Conventions under test: entities in/out BY LABEL (never slugs), engine-side name→slug
// joins, readable errors carrying nearest valid alternatives, deterministic output.

const t = (s: string, p: string, o: string): KbQuery.Triple => ({ s, p, o })

// member_of / album_by carry the band's display NAME (the rockfacts convention) — the
// engine must follow name→slug when such a value lands in subject position of a join.
const FIXTURE: KbQuery.Triple[] = [
  t("korvath-dreyne", "name", "Korvath Dreyne"),
  t("korvath-dreyne", "type", "musician"),
  t("korvath-dreyne", "member_of", "The Velvet Corvids"),
  t("korvath-dreyne", "role", "vocals"),
  t("korvath-dreyne", "born_in", "1968"),
  t("the-velvet-corvids", "name", "The Velvet Corvids"),
  t("the-velvet-corvids", "type", "band"),
  t("the-velvet-corvids", "origin_city", "Duskport"),
  t("the-velvet-corvids", "founded_in", "1987"),
  t("the-velvet-corvids", "genre", "doom metal"),
  t("mira-solenne", "name", "Mira Solenne"),
  t("mira-solenne", "type", "musician"),
  t("mira-solenne", "member_of", "The Velvet Corvids"),
  t("mira-solenne", "role", "guitar"),
  t("iron-halcyon", "name", "Iron Halcyon"),
  t("iron-halcyon", "type", "band"),
  t("iron-halcyon", "origin_city", "Duskport"),
  t("iron-halcyon", "genre", "doom metal"),
  t("tavish-morrow", "name", "Tavish Morrow"),
  t("tavish-morrow", "type", "musician"),
  t("tavish-morrow", "member_of", "Iron Halcyon"),
  t("ashen-hymnal", "name", "Ashen Hymnal"),
  t("ashen-hymnal", "type", "album"),
  t("ashen-hymnal", "album_by", "The Velvet Corvids"),
  t("ashen-hymnal", "released_in", "1991"),
]

const index = KbQuery.buildIndex(FIXTURE)

const ok = (op: KbQuery.Op): ReadonlyArray<string> => {
  const result = KbQuery.exec(index, op)
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`)
  return result.lines
}
const err = (op: KbQuery.Op): string => {
  const result = KbQuery.exec(index, op)
  if (result.ok) throw new Error(`expected error, got ${result.lines.length} lines`)
  return result.error
}

describe("KbQuery.resolveEntity", () => {
  test("passes slugs through, maps display names and slugified forms", () => {
    expect(KbQuery.resolveEntity(index, "the-velvet-corvids")).toEqual({ ok: true, slug: "the-velvet-corvids" })
    expect(KbQuery.resolveEntity(index, "The Velvet Corvids")).toEqual({ ok: true, slug: "the-velvet-corvids" })
    expect(KbQuery.resolveEntity(index, "The Velvet  CORVIDS!")).toEqual({ ok: true, slug: "the-velvet-corvids" })
  })

  test("miss returns nearest labels, prefix before word-overlap", () => {
    const missed = KbQuery.resolveEntity(index, "The Velvet Corvid")
    expect(missed.ok).toBe(false)
    if (!missed.ok) expect(missed.nearest).toEqual(["The Velvet Corvids"])
  })
})

describe("KbQuery.exec find", () => {
  test("exact label match is case-insensitive and ranked first", () => {
    expect(ok({ op: "find", label: "korvath dreyne" })).toEqual(["Korvath Dreyne"])
  })

  test("substring fragments find their entity", () => {
    expect(ok({ op: "find", label: "velvet" })).toEqual(["The Velvet Corvids"])
  })

  test("a typo miss errors with nearest labels (word overlap)", () => {
    expect(err({ op: "find", label: "Velvit Corvids" })).toContain("The Velvet Corvids")
  })

  test("missing label field is a readable repair error", () => {
    expect(err({ op: "find" })).toContain('"label"')
  })
})

describe("KbQuery.exec get", () => {
  test("returns linearized facts for a display name", () => {
    const lines = ok({ op: "get", entity: "The Velvet Corvids" })
    expect(lines).toContain("origin_city: Duskport")
    expect(lines).toContain("genre: doom metal")
    expect(lines).toHaveLength(5)
  })

  test("unknown entity lists nearest candidates", () => {
    expect(err({ op: "get", entity: "The Velvet Corvid" })).toContain("The Velvet Corvids")
  })

  test("limit is respected", () => {
    expect(ok({ op: "get", entity: "The Velvet Corvids", limit: 2 })).toHaveLength(2)
  })
})

describe("KbQuery.exec predicates", () => {
  test("returns the entity's distinct predicates, sorted (deterministic)", () => {
    expect(ok({ op: "predicates", entity: "Korvath Dreyne" })).toEqual([
      "born_in",
      "member_of",
      "name",
      "role",
      "type",
    ])
  })
})

describe("KbQuery.exec neighbors", () => {
  test("out follows one predicate from the entity", () => {
    expect(ok({ op: "neighbors", entity: "Korvath Dreyne", predicate: "member_of" })).toEqual(["The Velvet Corvids"])
  })

  test("unknown predicate on the entity lists ITS predicates", () => {
    const error = err({ op: "neighbors", entity: "Korvath Dreyne", predicate: "plays_in" })
    expect(error).toContain("member_of")
    expect(error).toContain("role")
  })

  test("direction in returns pointing entities as labels, not slugs", () => {
    expect(ok({ op: "neighbors", entity: "The Velvet Corvids", predicate: "member_of", direction: "in" })).toEqual([
      "Korvath Dreyne",
      "Mira Solenne",
    ])
    expect(ok({ op: "neighbors", entity: "The Velvet Corvids", predicate: "album_by", direction: "in" })).toEqual([
      "Ashen Hymnal",
    ])
  })

  test("direction in with an unknown global predicate suggests near ones", () => {
    expect(err({ op: "neighbors", entity: "The Velvet Corvids", predicate: "member", direction: "in" })).toContain(
      "member_of",
    )
  })
})

describe("KbQuery.exec match + count", () => {
  test("2-hop chain joins through the name→slug indirection", () => {
    expect(
      ok({
        op: "match",
        find: ["?city"],
        where: [
          ["Korvath Dreyne", "member_of", "?band"],
          ["?band", "origin_city", "?city"],
        ],
      }),
    ).toEqual(["Duskport"])
  })

  test("subject variables come back labeled", () => {
    expect(ok({ op: "match", find: ["?m"], where: [["?m", "member_of", "The Velvet Corvids"]] })).toEqual([
      "Korvath Dreyne",
      "Mira Solenne",
    ])
  })

  test("zero matches is ok + empty, not an error", () => {
    expect(ok({ op: "match", find: ["?x"], where: [["Korvath Dreyne", "member_of", "Iron Halcyon"]] })).toEqual([])
  })

  test("match respects limit", () => {
    expect(ok({ op: "match", find: ["?m"], where: [["?m", "type", "musician"]], limit: 2 })).toHaveLength(2)
  })

  test("count returns distinct binding cardinality", () => {
    expect(ok({ op: "count", find: ["?b"], where: [["?b", "genre", "doom metal"]] })).toEqual(["2"])
    expect(ok({ op: "count", find: ["?m"], where: [["?m", "member_of", "The Velvet Corvids"]] })).toEqual(["2"])
  })

  test("missing where is a readable repair error", () => {
    expect(err({ op: "count" })).toContain('"where"')
    expect(err({ op: "match", find: ["?x"] })).toContain('"where"')
  })
})
