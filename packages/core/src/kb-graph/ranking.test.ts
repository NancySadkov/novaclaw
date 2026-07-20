import { describe, expect, test } from "bun:test"
import { DEFAULT_WEIGHTS, maxSwing, rankHits, recencyFactor } from "./ranking"
import type { SearchHit } from "./wasm-engine"

// P8c — the falsifiable target for recall ORDERING, written before trusting the ranking.
// The owner's requirement in one line: a recent authoritative statement must outrank a three-year-old
// low-authority musing that merely uses matching words. These cases pin that down, AND pin the
// opposite failure — weighting must not let provenance bury a clearly better match.

const NOW = Date.parse("2026-07-20T00:00:00Z")
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const hit = (over: Partial<SearchHit> & { id: string; score: number }): SearchHit => ({
  kind: "episode",
  text: over.id,
  name: null,
  scope: "global",
  source: null,
  confidence: null,
  relation: "staged",
  ...over,
})

const order = (hits: SearchHit[]) => rankHits(hits, NOW).map((h) => h.id)

describe("recall ordering — the owner's case", () => {
  test("a recent AUTHORITATIVE statement outranks an older, better-WORDED low-authority musing", () => {
    // The musing wins on raw relevance (it happens to echo the query's words), so relevance alone gets
    // this WRONG — which is precisely why ordering exists.
    const musing = hit({ id: "junior-musing", score: 1.0, validAt: daysAgo(1095), source: "auto-extract" })
    const statement = hit({ id: "ceo-statement", score: 0.8, validAt: daysAgo(30), relation: "core" })
    expect([musing, statement].sort((a, b) => b.score - a.score)[0]!.id).toBe("junior-musing") // baseline is wrong
    expect(order([musing, statement])[0]).toBe("ceo-statement") // weighting fixes it
  })

  test("stale-residual: same provenance, the recent fact wins", () => {
    const old = hit({ id: "old", score: 1.0, validAt: daysAgo(1095) })
    const fresh = hit({ id: "fresh", score: 1.0, validAt: daysAgo(1) })
    expect(order([old, fresh])[0]).toBe("fresh")
  })
})

describe("the guard — weighting must not hijack relevance", () => {
  // maxSwing is the documented ceiling on how much provenance can overturn. Assert BOTH sides of it so
  // the constants can't drift into "recency decides everything" without failing here.
  test("a relevance gap WIDER than maxSwing survives weighting", () => {
    const ratio = maxSwing() + 0.3
    const relevant = hit({ id: "old-but-far-better", score: ratio, validAt: daysAgo(1095), source: "auto-extract" })
    const shiny = hit({ id: "recent-core-but-weak", score: 1.0, validAt: daysAgo(0), relation: "core" })
    expect(order([relevant, shiny])[0]).toBe("old-but-far-better")
  })

  test("a relevance gap NARROWER than maxSwing can be overturned", () => {
    const ratio = maxSwing() - 1.2
    const relevant = hit({ id: "old-slightly-better", score: ratio, validAt: daysAgo(1095), source: "auto-extract" })
    const shiny = hit({ id: "recent-core", score: 1.0, validAt: daysAgo(0), relation: "core" })
    expect(order([relevant, shiny])[0]).toBe("recent-core")
  })

  test("maxSwing matches the weights it documents", () => {
    expect(maxSwing(DEFAULT_WEIGHTS)).toBeCloseTo(1.5 / (0.55 * 0.85), 6)
  })
})

describe("neutral when uninformative", () => {
  test("uniform provenance and age ⇒ order UNCHANGED (no regression on a flat corpus)", () => {
    // The P7 document corpus is exactly this shape; ordering must be a no-op there.
    const hits = [1.0, 0.9, 0.8, 0.7].map((score, i) => hit({ id: `h${i}`, score, validAt: daysAgo(10) }))
    expect(order(hits)).toEqual(["h0", "h1", "h2", "h3"])
  })

  test("a missing timestamp is neutral, not penalised", () => {
    expect(recencyFactor(hit({ id: "x", score: 1 }), NOW)).toBe(1)
    expect(recencyFactor(hit({ id: "x", score: 1, validAt: "not-a-date" }), NOW)).toBe(1)
  })

  test("a future-dated fact gets no bonus over a present one", () => {
    const future = recencyFactor(hit({ id: "f", score: 1, validAt: daysAgo(-500) }), NOW)
    const present = recencyFactor(hit({ id: "p", score: 1, validAt: daysAgo(0) }), NOW)
    expect(future).toBeCloseTo(present, 10)
  })

  test("age discounts but never erases — an ancient fact keeps the floor", () => {
    expect(recencyFactor(hit({ id: "ancient", score: 1, validAt: daysAgo(100000) }), NOW)).toBeCloseTo(
      DEFAULT_WEIGHTS.recencyFloor,
      6,
    )
  })

  test("stable: equal ranked scores keep retrieval order", () => {
    const hits = [hit({ id: "a", score: 1, validAt: daysAgo(5) }), hit({ id: "b", score: 1, validAt: daysAgo(5) })]
    expect(order(hits)).toEqual(["a", "b"])
  })
})

describe("authority tiers", () => {
  test("core > deliberate write > passive auto-extraction, all else equal", () => {
    const core = hit({ id: "core", score: 1, relation: "core", validAt: daysAgo(10) })
    const stated = hit({ id: "stated", score: 1, validAt: daysAgo(10) })
    const derived = hit({ id: "derived", score: 1, source: "auto-extract", validAt: daysAgo(10) })
    expect(order([derived, stated, core])).toEqual(["core", "stated", "derived"])
  })
})
