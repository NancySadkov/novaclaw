import { describe, expect, test } from "bun:test"
import { SessionRecall } from "@novaclaw/core/session/runner/recall"
import type { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import type { SessionMessage } from "@novaclaw/core/session/message"

// Pure auto-recall helpers: the query is the latest user text, the budget shrinks for weak models,
// and the injected block is silent-use context (undefined when there's nothing to recall).

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const assistant = (): SessionMessage.Message => ({ type: "assistant", content: [] }) as unknown as SessionMessage.Message

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
})
