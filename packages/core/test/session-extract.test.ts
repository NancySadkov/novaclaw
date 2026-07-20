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

describe("SessionExtract.buildLinkPrompt", () => {
  test("appends the closed SUBJECTS list to the exchange", () => {
    expect(SessionExtract.buildLinkPrompt("User: hi", ["Acme", "Berlin"])).toBe("User: hi\n\nSUBJECTS:\n- Acme\n- Berlin")
  })
})

describe("SessionExtract.parseLinks", () => {
  const names = ["Nancy", "Acme Robotics", "Berlin"]

  test("resolves endpoints to CANONICAL list names and normalizes the type", () => {
    const out = SessionExtract.parseLinks('[{"from":"nancy","to":"Acme","type":"works at"}]', names)
    expect(out).toEqual([{ from: "Nancy", to: "Acme Robotics", type: "works_at" }])
  })

  // The dangling guard — the whole reason stage 2 gets a CLOSED list. An off-list endpoint (the
  // measured one-stage failure: "billing_service_owner") must never become an edge.
  test("DROPS links with an off-list endpoint rather than writing a dangling edge", () => {
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Sofia\'s Role","type":"knows"}]', names)).toEqual([])
    expect(SessionExtract.parseLinks('[{"from":"Nobody","to":"Nowhere","type":"x"}]', names)).toEqual([])
  })

  test("drops self-links and duplicate pairs", () => {
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Nancy","type":"is"}]', names)).toEqual([])
    const dup = SessionExtract.parseLinks(
      '[{"from":"Nancy","to":"Berlin","type":"lives_in"},{"from":"nancy","to":"berlin","type":"resides_in"}]',
      names,
    )
    expect(dup).toHaveLength(1)
  })

  test("a bad or missing type falls back to related_to — a good pair is never lost to a bad label", () => {
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Berlin"}]', names)[0]?.type).toBe("related_to")
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Berlin","type":"!!!"}]', names)[0]?.type).toBe("related_to")
  })

  test("tolerates fences/prose, never throws, and needs ≥2 names to link anything", () => {
    expect(SessionExtract.parseLinks('```json\n[{"from":"Nancy","to":"Berlin","type":"in"}]\n```', names)).toHaveLength(1)
    expect(SessionExtract.parseLinks("not json", names)).toEqual([])
    expect(SessionExtract.parseLinks("[]", names)).toEqual([])
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Berlin","type":"in"}]', ["Nancy"])).toEqual([])
  })

  test("caps to max", () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ from: "Nancy", to: `T${i}`, type: "t" })))
    expect(SessionExtract.parseLinks(many, ["Nancy", ...Array.from({ length: 30 }, (_, i) => `T${i}`)], 5)).toHaveLength(5)
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
