import { describe, expect, test } from "bun:test"
import { Message } from "@novaclaw/llm"
import { RequestFootprint as RF } from "./footprint"

const tool = (name: string, description = "") => ({ name, description, jsonSchema: { type: "object" } })
const input = (over: Partial<RF.Input> = {}): RF.Input => ({
  system: [{ text: "you are a helpful assistant" }],
  messages: [Message.user("hi")],
  tools: [tool("read"), tool("bash")],
  ...over,
})

// 🔴 THE property. Everything else here is arithmetic; this is the one that decides whether the
// diagnostic is shippable at all, because a per-turn measurement of a request is one accidental
// field away from being a per-turn copy of the user's conversation into the logs.
describe("content-free: sizes get out, text does not", () => {
  // Distinctive enough that a substring match cannot miss it and cannot false-positive.
  const SECRET = "zqx-canary-4417-do-not-log"

  test("no user text reaches the footprint, from ANY section", () => {
    const footprint = RF.measure({
      system: [{ text: `system prompt ${SECRET}` }],
      messages: [Message.user(`please read ${SECRET}`), Message.assistant(`sure, ${SECRET}`)],
      tools: [tool("read", `a tool whose DESCRIPTION mentions ${SECRET}`)],
    })
    expect(JSON.stringify(footprint)).not.toContain(SECRET)
  })

  test("and not through the log attributes either — the form that actually egresses", () => {
    // The struct staying clean is worth nothing if the projection to attributes reintroduces text.
    const footprint = RF.measure({
      system: [{ text: SECRET }],
      messages: [Message.user(SECRET)],
      tools: [tool("read", SECRET)],
    })
    expect(JSON.stringify(RF.attributes(footprint))).not.toContain(SECRET)
  })

  test("🔴 EVERY attribute is a number — that is what makes the event egress-safe", () => {
    // `log-events.ts` derives an event's content class from its attribute classes. All-numeric means
    // every attribute is `count`, which is egress: true, which means `content: "none"` is a FACT and
    // not a promise. One string would have to be declared `id` ("a value from a closed vocabulary")
    // — and a `define_tool` name is not from a closed vocabulary.
    for (const value of Object.values(RF.attributes(RF.measure(input())))) expect(typeof value).toBe("number")
  })

  test("the tool NAME stays in the struct and off the wire", () => {
    // The struct is richer than the event on purpose: the name is useful to whatever renders this
    // locally, and it is the one field that could carry user-authored text.
    const footprint = RF.measure(input())
    expect(footprint.largestTool?.name).toBeDefined()
    expect(Object.keys(RF.attributes(footprint))).not.toContain("request.tools.largest.name")
  })
})

describe("the arithmetic", () => {
  test("total is the sum of its parts", () => {
    const f = RF.measure(input())
    expect(f.totalBytes).toBe(f.systemBytes + f.messageBytes + f.toolBytes)
  })

  test("counts follow the inputs", () => {
    const f = RF.measure(input({ tools: [tool("a"), tool("b"), tool("c")] }))
    expect(f.toolCount).toBe(3)
    expect(f.messageCount).toBe(1)
    expect(f.systemPartCount).toBe(1)
  })

  test("the tool share is the headline, and it tracks the tools", () => {
    // Messages growing is a conversation getting longer. Tools growing is a fixed cost added to every
    // FUTURE turn by a change made somewhere else — which is the one this number exists to catch.
    const lean = RF.measure(input({ tools: [tool("a")] }))
    const heavy = RF.measure(input({ tools: Array.from({ length: 40 }, (_, i) => tool(`tool_${i}`, "x".repeat(200))) }))
    expect(heavy.toolSharePercent).toBeGreaterThan(lean.toolSharePercent)
    expect(heavy.toolSharePercent).toBeLessThanOrEqual(100)
  })

  test("🔴 an empty request reports 0, never NaN", () => {
    // A boot probe legitimately sends no tools and no history. NaN in a log attribute is worse than
    // zero: it renders, it sorts, and it means nothing.
    const f = RF.measure({ system: [], messages: [], tools: [] })
    expect(f.toolSharePercent).toBe(0)
    expect(Number.isNaN(f.toolSharePercent)).toBe(false)
    expect(f.totalBytes).toBe(0)
    expect(f.largestTool).toBeUndefined()
  })

  test("the largest tool is identified, so the number has an address", () => {
    const f = RF.measure(input({ tools: [tool("small"), tool("huge", "x".repeat(5000)), tool("medium", "x".repeat(50))] }))
    expect(f.largestTool?.name).toBe("huge")
  })

  test("a tool without a name still reports a size rather than vanishing", () => {
    const f = RF.measure(input({ tools: [{}] }))
    expect(f.largestTool?.name).toBe("(unnamed)")
  })
})

describe("a diagnostic must never be the reason a turn fails", () => {
  test("🔴 a cyclic structure degrades to 0 instead of throwing", () => {
    // `JSON.stringify` throws on a cycle. Taking down a real conversation to report a number nobody
    // asked for is the worst possible trade, so every failure here reads LOW rather than fatal.
    const cyclic: Record<string, unknown> = { name: "loop" }
    cyclic.self = cyclic
    expect(() => RF.measure(input({ tools: [cyclic as { name?: string }] }))).not.toThrow()
    expect(RF.measure(input({ tools: [cyclic as { name?: string }] })).toolBytes).toBe(0)
  })
})

describe("estimated tokens ride the ONE shared heuristic", () => {
  test("tokens track bytes at the shared ratio, and are not a second estimator", () => {
    // `util/token.ts` is the single approximation used by packing, compaction and the live badge.
    // A second ratio here would make two parts of the app disagree about the same request.
    const f = RF.measure(input({ messages: [Message.user("x".repeat(4000))] }))
    expect(f.estimatedTokens).toBe(Math.round(f.totalBytes / 4))
  })

  test("it is an estimate and is named as one — never compared to a provider count", () => {
    expect(RF.measure(input()).estimatedTokens).toBeGreaterThan(0)
  })
})
