import { describe, expect, test } from "bun:test"
import { DEFAULT_WEIGHTS, confidenceFactor, maxSwing, rankHits, recencyFactor } from "./ranking"
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
  status: "active",
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
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
  //
  // ⚠️ The two hits below sit at the EXTREMES of every factor at once — the best case against the
  // worst case — because that is the only pair the ceiling actually describes. An earlier version used
  // a pair that varied recency and provenance only, so adding kind, status and confidence raised the
  // real ceiling while this test went on comparing against the old one.
  const best = (score: number) =>
    hit({ id: "recent-core", score, validAt: daysAgo(0), relation: "core", status: "active", confidence: 1 })
  const worst = (score: number) =>
    hit({
      id: "old-passage",
      score,
      validAt: daysAgo(1095),
      source: "ingest",
      kind: "passage",
      status: "needs_review",
      confidence: 0,
    })

  test("a relevance gap WIDER than maxSwing survives weighting", () => {
    expect(order([worst(maxSwing() + 0.3), best(1.0)])[0]).toBe("old-passage")
  })

  test("a relevance gap NARROWER than maxSwing can be overturned", () => {
    expect(order([worst(maxSwing() - 1.2), best(1.0)])[0]).toBe("recent-core")
  })

  test("maxSwing matches the weights it documents", () => {
    expect(maxSwing(DEFAULT_WEIGHTS)).toBeCloseTo(1.5 / (0.55 * 0.7 * 0.85 * 0.9), 6)
  })

  test("🔴 …and it stays inside the policy bound — a new signal may not quietly widen it", () => {
    // The ceiling grew from ~3.2 to ~5.1 when status, confidence and kind landed, deliberately.
    // 6 is the line: past it, a hit six times less relevant could win on metadata alone, which is no
    // longer "re-rank comparable candidates".
    expect(maxSwing(DEFAULT_WEIGHTS)).toBeLessThan(6)
  })
})

describe("the lifecycle signals", () => {
  test("a governed CLAIM outranks an ordinary memory of equal relevance", () => {
    const claim = hit({ id: "claim", score: 1, kind: "claim", validAt: daysAgo(10) })
    const plain = hit({ id: "plain", score: 1, kind: "episode", validAt: daysAgo(10) })
    expect(order([plain, claim])[0]).toBe("claim")
  })

  test("🔴 an AUTO-EXTRACTED claim does not — a guess is not laundered by having a subject", () => {
    const guessed = hit({ id: "guessed", score: 1, kind: "claim", source: "auto-extract", validAt: daysAgo(10) })
    const stated = hit({ id: "stated", score: 1, kind: "entity", validAt: daysAgo(10) })
    expect(order([guessed, stated])[0]).toBe("stated")
  })

  test("a raw passage ranks below an equally relevant memory", () => {
    const passage = hit({ id: "passage", score: 1, kind: "passage", source: "ingest", validAt: daysAgo(10) })
    const memory = hit({ id: "memory", score: 1, kind: "entity", validAt: daysAgo(10) })
    expect(order([passage, memory])[0]).toBe("memory")
  })

  test("needs_review is DISCOUNTED, never buried — it is still the only answer we have", () => {
    const flagged = hit({ id: "flagged", score: 1, kind: "claim", status: "needs_review", validAt: daysAgo(10) })
    const sound = hit({ id: "sound", score: 1, kind: "claim", status: "active", validAt: daysAgo(10) })
    expect(order([flagged, sound])).toEqual(["sound", "flagged"])
    // Shallow enough that a clearly better match still wins.
    expect(order([hit({ ...flagged, score: 1.4 }), sound])[0]).toBe("flagged")
  })

  test("confidence lifts, and a MISSING one is neutral — no writer has ever set this column", () => {
    expect(confidenceFactor(hit({ id: "x", score: 1 }))).toBe(1)
    expect(confidenceFactor(hit({ id: "x", score: 1, confidence: 1 }))).toBe(1)
    expect(confidenceFactor(hit({ id: "x", score: 1, confidence: 0 }))).toBe(DEFAULT_WEIGHTS.confidenceFloor)
    const sure = hit({ id: "sure", score: 1, confidence: 1, validAt: daysAgo(10) })
    const unsure = hit({ id: "unsure", score: 1, confidence: 0, validAt: daysAgo(10) })
    expect(order([unsure, sure])[0]).toBe("sure")
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
