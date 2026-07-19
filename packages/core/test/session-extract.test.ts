import { describe, expect, test } from "bun:test"
import { SessionExtract } from "@novaclaw/core/session/runner/extract"
import type { SessionMessage } from "@novaclaw/core/session/message"

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const assistant = (...texts: string[]): SessionMessage.Message =>
  ({ type: "assistant", content: texts.map((text) => ({ type: "text", text })) }) as unknown as SessionMessage.Message

describe("SessionExtract.buildExchange", () => {
  test("serializes the latest user message + the assistant text that followed it", () => {
    const ex = SessionExtract.buildExchange([user("old"), assistant("old reply"), user("my name is Nadia"), assistant("Nice to", " meet you")])
    expect(ex).toBe("User: my name is Nadia\nAssistant: Nice to meet you")
  })
  test("no assistant reply yet → just the user line; no user → undefined", () => {
    expect(SessionExtract.buildExchange([user("hi there")])).toBe("User: hi there")
    expect(SessionExtract.buildExchange([assistant("hello")])).toBeUndefined()
    expect(SessionExtract.buildExchange([])).toBeUndefined()
  })
})

describe("SessionExtract.parseExtraction", () => {
  test("parses a plain JSON array of {name,text}", () => {
    const out = SessionExtract.parseExtraction('[{"name":"Nadia","text":"The user is named Nadia"},{"text":"Prefers dark mode"}]')
    expect(out).toEqual([{ name: "Nadia", text: "The user is named Nadia" }, { text: "Prefers dark mode" }])
  })
  test("tolerates code fences + surrounding prose", () => {
    const out = SessionExtract.parseExtraction('Here you go:\n```json\n[{"text":"Deadline is March 15"}]\n```\nDone.')
    expect(out).toEqual([{ text: "Deadline is March 15" }])
  })
  test("drops malformed/empty entries, dedups, and never throws", () => {
    expect(SessionExtract.parseExtraction("not json at all")).toEqual([])
    expect(SessionExtract.parseExtraction("[]")).toEqual([])
    expect(
      SessionExtract.parseExtraction('[{"text":"same"},{"text":"SAME"},{"nope":1},{"text":"  "},{"text":"kept"}]'),
    ).toEqual([{ text: "same" }, { text: "kept" }])
  })
  test("caps to max", () => {
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ text: `fact ${i}` })))
    expect(SessionExtract.parseExtraction(many, 3)).toHaveLength(3)
  })
})

describe("SessionExtract.memoryID", () => {
  test("deterministic + idempotent: same scope+text → same id, case/space-insensitive", () => {
    const a = SessionExtract.memoryID("session:x", "The user is named Nadia")
    expect(a).toBe(SessionExtract.memoryID("session:x", "  the user is named nadia  "))
    expect(a).toMatch(/^mem_x[0-9a-f]{24}$/)
    expect(a).not.toBe(SessionExtract.memoryID("global", "The user is named Nadia")) // scope matters
    expect(a).not.toBe(SessionExtract.memoryID("session:x", "different fact"))
  })
})
