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
    expect(SessionRecall.formatRecall([])).toBeUndefined()
    const block = SessionRecall.formatRecall([hit("Nadia   prefers\ndark mode", "Nadia"), hit("Berlin-based")])
    expect(block).toContain("don't mention or repeat this list")
    const lines = block!.split("\n")
    expect(lines).toContain("- Nadia: Nadia prefers dark mode")
    expect(lines).toContain("- Berlin-based")
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
