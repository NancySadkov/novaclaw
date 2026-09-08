import { describe, expect, test } from "bun:test"
import { buildRerankPrompt, parseRerankOrder, rerank } from "./rerank"
import type { SearchHit } from "./wasm-engine"

// The reranker must never fail a caller and never silently drop a candidate. These pin the pure
// halves; whether the model actually ranks BETTER is a live measurement (tests/rag-rerank-eval.ts).

const NOW = Date.parse("2026-07-20T00:00:00Z")
const hit = (id: string, over: Partial<SearchHit> = {}): SearchHit => ({
  id,
  kind: "episode",
  text: `text of ${id}`,
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
  score: 1,
  ...over,
})

describe("parseRerankOrder", () => {
  test("reads a comma-separated ordering as 0-based indices", () => {
    expect(parseRerankOrder("3, 1, 2", 3)).toEqual([2, 0, 1])
  })

  test("tolerates prose and odd separators around the numbers", () => {
    expect(parseRerankOrder("Best-first order: 2 then 1 then 3.", 3)).toEqual([1, 0, 2])
  })

  test("APPENDS omissions — a partial answer must never drop candidates", () => {
    expect(parseRerankOrder("2", 4)).toEqual([1, 0, 2, 3])
  })

  test("ignores out-of-range and duplicate picks", () => {
    expect(parseRerankOrder("9, 2, 2, 0, 1", 3)).toEqual([1, 0, 2])
  })

  test("undefined when nothing usable came back (routes to the deterministic fallback)", () => {
    expect(parseRerankOrder("I cannot help with that", 3)).toBeUndefined()
    expect(parseRerankOrder("", 3)).toBeUndefined()
    expect(parseRerankOrder("1", 0)).toBeUndefined()
  })

  test("always returns a complete permutation", () => {
    const out = parseRerankOrder("5,1", 5)!
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })
})

describe("buildRerankPrompt", () => {
  test("numbers candidates from 1 and carries age + provenance for judging", () => {
    const { system, user } = buildRerankPrompt(
      "remote policy?",
      [
        hit("a", {
          text: "Official policy: three days in office",
          validAt: new Date(NOW - 400 * 86_400_000).toISOString(),
          relation: "core",
        }),
        hit("b", {
          text: "I think nobody checks anymore",
          validAt: new Date(NOW - 3 * 86_400_000).toISOString(),
          source: "auto-extract",
        }),
      ],
      NOW,
    )
    expect(user).toContain("1. (400d old; curated)")
    expect(user).toContain("2. (3d old; auto-noted)")
    expect(user).toContain("remote policy?")
    // The example teaches the principle: definitive+older can outrank casual+newer.
    expect(system).toContain("Correct order: A, B")
    expect(system).toContain("authoritative")
  })

  test("marks an unknown timestamp rather than inventing an age", () => {
    expect(buildRerankPrompt("q", [hit("a"), hit("b")], NOW).user).toContain("age unknown")
  })
})

describe("rerank", () => {
  const ok = async () => "2,1"

  test("reorders by the model's answer", async () => {
    const out = await rerank("q", [hit("a"), hit("b")], ok, NOW)
    expect(out?.map((h) => h.id)).toEqual(["b", "a"])
  })

  test("declines to rank when there is nothing to decide", async () => {
    expect(await rerank("q", [hit("a")], ok, NOW)).toBeUndefined()
    expect(await rerank("   ", [hit("a"), hit("b")], ok, NOW)).toBeUndefined()
  })

  test("a throwing or useless model degrades to undefined, never throws", async () => {
    const boom = async () => {
      throw new Error("model down")
    }
    expect(await rerank("q", [hit("a"), hit("b")], boom, NOW)).toBeUndefined()
    expect(await rerank("q", [hit("a"), hit("b")], async () => "no numbers here", NOW)).toBeUndefined()
  })

  test("keeps every candidate even when the model answers partially", async () => {
    const out = await rerank("q", [hit("a"), hit("b"), hit("c")], async () => "3", NOW)
    expect(out?.map((h) => h.id)).toEqual(["c", "a", "b"])
  })
})

describe("the reranker can refuse every candidate", () => {
  // 🔴 Measured on the owner's own instance, 2026-08-20: asked to describe six PNGs, the model
  // answered about "Eldath Scrolls", a "Codex of the Pale Eclipse" and an `add.js` JSDoc note. Rule 1
  // ranks an off-topic fact LAST and the parser never dropped one, so when EVERY candidate was
  // off-topic they were all injected anyway. Ordering cannot fix "nothing here belongs".
  test("a bare `none` drops everything", () => {
    expect(parseRerankOrder("none", 3)).toEqual([])
    expect(parseRerankOrder("None.", 5)).toEqual([])
    expect(parseRerankOrder("  NONE  ", 2)).toEqual([])
  })

  test("`none` alongside numbers is ORDERING, not refusal", () => {
    // ⚠️ The case that makes the word alone unsafe. "none of 3, so 1, 2" is a model ranking, and
    // reading the refusal would silently discard the memories it just ranked.
    // ⚠️ [2,0,1], not [0,1,2]: the parser reads EVERY digit as a pick, so the "3" in "none of 3" is
    // itself a selection. Tolerant by design — and the reason the drop-all escape must require a
    // reply with NO digits at all, rather than trusting the word.
    expect(parseRerankOrder("none of 3, so: 1, 2", 3)).toEqual([2, 0, 1])
    expect(parseRerankOrder("2, 1 — none of the others", 2)).toEqual([1, 0])
  })

  test("word boundaries: a word CONTAINING none is not a refusal", () => {
    // The boundaries were lost once to a mangled escape, leaving a regex that could never match.
    // Without them these read as "drop everything".
    expect(parseRerankOrder("nonexistent", 2)).toBeUndefined()
    expect(parseRerankOrder("nonsense", 2)).toBeUndefined()
  })

  test("refusal and unusable stay DISTINCT", () => {
    // `[]` is a decision — nothing here helps, inject nothing. `undefined` is "unusable reply", which
    // routes the caller to the deterministic ranker and keeps everything. Collapsing them would turn
    // every garbled reply into silent memory loss.
    expect(parseRerankOrder("none", 3)).toEqual([])
    expect(parseRerankOrder("", 3)).toBeUndefined()
    expect(parseRerankOrder("I cannot help with that", 3)).toBeUndefined()
  })
})
