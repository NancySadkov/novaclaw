import { describe, expect, test } from "bun:test"
import { SessionRecall } from "@novaclaw/core/session/runner/recall"
import type { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import type { SessionMessage } from "@novaclaw/core/session/message"

// Pure auto-recall helpers: the query is the latest user text, the budget shrinks for weak models,
// and the injected block is silent-use context (undefined when there's nothing to recall).

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const assistant = (): SessionMessage.Message =>
  ({ type: "assistant", content: [] }) as unknown as SessionMessage.Message

const hit = (text: string, name: string | null = null): MemoryClient.SearchHit => ({
  id: "mem_1",
  kind: "entity",
  text,
  name,
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
})

describe("SessionRecall", () => {
  test("recallQuery = the latest user message text", () => {
    expect(SessionRecall.recallQuery([user("first"), assistant(), user("what do I prefer?")])).toBe("what do I prefer?")
  })

  test("recallQuery ignores trailing assistant turns, returns undefined with no user / empty text", () => {
    expect(SessionRecall.recallQuery([user("hi"), assistant()])).toBe("hi")
    expect(SessionRecall.recallQuery([assistant()])).toBeUndefined()
    expect(SessionRecall.recallQuery([user("   ")])).toBeUndefined()
    expect(SessionRecall.recallQuery([])).toBeUndefined()
  })

  test("recallBudget shrinks for weak models (JH floor)", () => {
    expect(SessionRecall.recallBudget("micro")).toBe(3)
    expect(SessionRecall.recallBudget("tiny")).toBe(3)
    expect(SessionRecall.recallBudget("small")).toBe(5)
    expect(SessionRecall.recallBudget("large")).toBe(8)
    expect(SessionRecall.recallBudget(undefined)).toBe(8)
  })

  test("formatRecall: undefined when empty; a silent-use block with one line per memory otherwise", () => {
    expect(SessionRecall.formatRecall(SessionRecall.packRecall([], 900))).toBeUndefined()
    const block = SessionRecall.formatRecall(
      SessionRecall.packRecall([hit("Nadia   prefers\ndark mode", "Nadia"), hit("Berlin-based")], 900),
    )
    expect(block).toContain("don't mention or repeat this list")
    const lines = block!.split("\n")
    expect(lines).toContain("- Nadia: Nadia prefers dark mode")
    expect(lines).toContain("- Berlin-based")
    // Nothing was left out, so the block says nothing about omission. An omission notice on a
    // complete recall would teach the model to distrust a list that is in fact whole.
    expect(block).not.toContain("did not fit")
  })

  test("finds recalled memories that cite an exact Windows path", () => {
    const stale = hit("The file C:\\Users\\Nangl\\work\\pi.c already implements the program.")
    const other = { ...hit("Use C:\\Users\\Nangl\\work\\other.c instead."), id: "mem_2" }
    expect(
      SessionRecall.memoriesMentioningPath([stale, other], ["C:/users/nangl/work/pi.c"]).map((row) => row.id),
    ).toEqual(["mem_1"])
  })

  test("does not confuse a missing path with a nearby filename or a path fragment", () => {
    const backup = hit("C:\\Users\\nangl\\work\\pi.c.bak exists.")
    const nested = { ...hit("See D:\\archive\\C:\\Users\\nangl\\work\\pi.c"), id: "mem_2" }
    expect(SessionRecall.memoriesMentioningPath([backup, nested], ["C:\\Users\\nangl\\work\\pi.c"])).toEqual([])
  })

  test("keeps POSIX path matching case-sensitive", () => {
    const upper = hit("The source is at /home/nangl/Pi.c.")
    expect(SessionRecall.memoriesMentioningPath([upper], ["/home/nangl/pi.c"])).toEqual([])
    expect(SessionRecall.memoriesMentioningPath([upper], ["/home/nangl/Pi.c"])).toEqual([upper])
  })
})

describe("the bounded context pack", () => {
  const claim = (text: string, over: Partial<MemoryClient.SearchHit> = {}): MemoryClient.SearchHit => ({
    ...hit(text),
    kind: "claim",
    subject: "the user",
    predicate: "about",
    ...over,
  })
  const passage = (text: string, id: string): MemoryClient.SearchHit => ({ ...hit(text), id, kind: "passage" })

  test("the budget is TOKENS, so one long passage no longer costs what one short fact costs", () => {
    const short = { ...hit("Berlin-based"), id: "a" }
    const long = passage("x".repeat(4000), "b")
    // The old item budget admitted both at a budget of 2. A thousand estimated tokens does not fit
    // in two hundred, and that is the whole difference.
    const pack = SessionRecall.packRecall([short, long], SessionRecall.recallTokenBudget("micro"))
    expect(pack.shown.map((row) => row.id)).toEqual(["a"])
    expect(pack.omitted).toBe(1)
  })

  test("a standing constraint is admitted even when it ALONE overruns the whole budget", () => {
    // ~100 estimated tokens of standing instruction against a 10-token budget. "Protected from
    // truncation" is a promise, not a weight — implementing it as "given the best weight" would
    // leave a tight enough budget able to drop the instruction the user gave once and expects to
    // hold. The honest failure is an over-budget pack that kept it.
    const language = claim("Always answer in Dutch, however the question was asked. ".repeat(7), {
      id: "pref",
      predicate: "language",
    })
    const filler = passage("y".repeat(8000), "filler")
    const pack = SessionRecall.packRecall([filler, language], 10)
    expect(pack.shown.map((row) => row.id)).toEqual(["pref"])
    expect(pack.protectedCount).toBe(1)
    expect(pack.tokens).toBeGreaterThan(10)
  })

  test("a current identified claim outranks evidence, and evidence is what gets dropped", () => {
    const current = claim("Ann works at Acme.", { id: "clm", subject: "Ann", predicate: "employer" })
    const evidence = passage("z".repeat(600), "src")
    const musing = { ...hit("w".repeat(600)), id: "epi", kind: "episode" as const }
    const pack = SessionRecall.packRecall([evidence, musing, current], 200)
    expect(pack.shown.map((row) => row.id)).toEqual(["epi", "clm"])
    // Ranked order is preserved even though the packer walked by tier — a list that visibly jumps
    // between priorities reads as noise.
    expect(pack.omitted).toBe(1)
  })

  test("a hit that does not fit is SKIPPED, not stopped on — within one tier", () => {
    // Both in tier 1, so the ONLY thing that can order them is the fill loop. A `break` on the first
    // over-budget hit would let one long memory hide every short one ranked behind it.
    const big = { ...hit("q".repeat(2000)), id: "big", kind: "episode" as const }
    const small = { ...hit("Berlin-based"), id: "small", kind: "episode" as const }
    const pack = SessionRecall.packRecall([big, small], 100)
    expect(pack.shown.map((row) => row.id)).toEqual(["small"])
  })

  test("the block SAYS when material was left out", () => {
    const pack = SessionRecall.packRecall(
      [passage("a".repeat(4000), "p1"), passage("b".repeat(4000), "p2"), { ...hit("Berlin-based"), id: "s" }],
      100,
    )
    const block = SessionRecall.formatRecall(pack)!
    // A model handed a silently truncated list answers with the confidence of a complete recall.
    expect(block).toContain("2 further relevant memories did not fit")
    expect(block).toContain("kb tool")
  })

  test("a superseded claim never reaches the protected tier", () => {
    // It is out of `RECALL_STATUSES` anyway, but the tiering must not be the place that forgets it:
    // a retired answer protected from truncation would outlive the correction that replaced it.
    expect(SessionRecall.recallTier(claim("old", { status: "superseded" }))).not.toBe(0)
    expect(SessionRecall.recallTier(claim("flagged", { status: "needs_review" }))).not.toBe(0)
  })

  test("token budgets shrink for weak models, and the estimate is characters over four", () => {
    expect(SessionRecall.recallTokenBudget("micro")).toBe(200)
    expect(SessionRecall.recallTokenBudget("small")).toBe(400)
    expect(SessionRecall.recallTokenBudget(undefined)).toBe(900)
    expect(SessionRecall.estimateTokens("abcd".repeat(25))).toBe(25)
  })
})

describe("recallPoolSize", () => {
  // The pool is what the RANKER chooses from; the budget is what the MODEL SEES. Keeping them
  // separate is the point — see the D20 bisection (answer at hybrid rank 12-18).
  test("weak tiers get a pool far wider than their context budget", () => {
    const micro = SessionRecall.recallBudget("micro")
    expect(micro).toBe(3)
    // 3x3=9 could not contain an answer measured at rank 12-18; the floor fixes exactly that.
    expect(SessionRecall.recallPoolSize(micro)).toBe(16)
  })

  test("stronger tiers scale past the floor", () => {
    expect(SessionRecall.recallPoolSize(SessionRecall.recallBudget(undefined))).toBe(24)
  })

  test("capped so rerank cost stays bounded", () => {
    expect(SessionRecall.recallPoolSize(20)).toBe(40) // 20*3=60 -> capped
  })

  test("the show-what-you-retrieved invariant WINS over the cost cap", () => {
    // Degenerate input only (real budgets are <= 8), but the precedence must be deliberate: a pool
    // smaller than the budget would silently show fewer memories than asked for.
    expect(SessionRecall.recallPoolSize(100)).toBe(100)
  })

  test("never retrieves fewer than it will show", () => {
    for (const budget of [1, 3, 5, 8, 16, 40, 64]) {
      expect(SessionRecall.recallPoolSize(budget)).toBeGreaterThanOrEqual(budget)
    }
  })
})
