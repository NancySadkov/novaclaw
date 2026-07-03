import { describe, expect, test } from "bun:test"
import { Message, SystemPart, ToolDefinition } from "@novaclaw/llm"
import { SessionInput } from "../input"
import {
  budget,
  ctxPressure,
  demoteSystemMessages,
  dropDanglingToolCalls,
  dropOrphanTools,
  estimateMessage,
  isRealUserMessage,
  pack,
  BUDGET_KEEP_FRACTION,
  DEFAULT_CONTEXT_SIZE,
  MIN_RESPONSE_RESERVE,
  PRESSURE_THRESHOLD,
} from "./context-pack"

const user = (text: string) => Message.user(text)
const steer = (text: string) => Message.user(SessionInput.applySteerProvenance(text))
const assistantText = (text: string) => Message.assistant(text)
const assistantCall = (id: string, name = "read", input: unknown = { path: "a" }) =>
  Message.assistant([{ type: "tool-call", id, name, input }])
const toolResult = (id: string, name = "read", result: unknown = "ok") => Message.tool({ id, name, result })
const system = (text: string) => Message.system(text)

const noSystem: SystemPart[] = []
const noTools: ToolDefinition[] = []

// Empty tools still stringify to "[]" (~1 token); mirror the impl formula exactly.
const expectedBudget = (contextSize: number, reserve: number) =>
  Math.floor((contextSize - reserve - 1) * BUDGET_KEEP_FRACTION)

describe("budget", () => {
  test("subtracts system, tools, reserve, and headroom", () => {
    const value = budget({ contextSize: 64_000, system: noSystem, tools: noTools })
    // reserve = max(64000/8, 8192) = 8192
    expect(value).toBe(expectedBudget(64_000, MIN_RESPONSE_RESERVE))
  })

  test("reserve scales with the window for big contexts", () => {
    const value = budget({ contextSize: 256_000, system: noSystem, tools: noTools })
    expect(value).toBe(expectedBudget(256_000, 32_000))
  })

  test("an explicit maxTokens raises the reserve", () => {
    const value = budget({ contextSize: 64_000, system: noSystem, tools: noTools, maxTokens: 20_000 })
    expect(value).toBe(expectedBudget(64_000, 20_000))
  })

  test("system and tool text eat the budget, never below zero", () => {
    const bigSystem = [SystemPart.make("x".repeat(400_000))]
    expect(budget({ contextSize: 32_000, system: bigSystem, tools: noTools })).toBe(0)
  })
})

describe("estimateMessage", () => {
  test("scales with content length and adds tool-call overhead", () => {
    const small = estimateMessage(user("hi"))
    const large = estimateMessage(user("x".repeat(4000)))
    expect(large).toBeGreaterThan(small + 900)
    const call = estimateMessage(assistantCall("c1"))
    const noCall = estimateMessage(assistantText(JSON.stringify({ type: "tool-call", id: "c1" })))
    expect(call).toBeGreaterThanOrEqual(noCall)
  })
})

describe("isRealUserMessage", () => {
  test("user yes, steer no, assistant no", () => {
    expect(isRealUserMessage(user("task"))).toBe(true)
    expect(isRealUserMessage(steer("nudge"))).toBe(false)
    expect(isRealUserMessage(assistantText("hello"))).toBe(false)
  })
})

describe("dropDanglingToolCalls", () => {
  test("removes an unanswered tool call (the abort-mid-tool 400)", () => {
    const messages = [user("go"), assistantCall("c1"), assistantCall("c2"), toolResult("c2")]
    const repaired = dropDanglingToolCalls(messages)
    // c1's assistant had ONLY the dangling call -> whole message dropped.
    expect(repaired).toHaveLength(3)
    expect(repaired.some((m) => m.content.some((p) => p.type === "tool-call" && p.id === "c1"))).toBe(false)
  })

  test("keeps text siblings when only the call part is dangling", () => {
    const mixed = Message.assistant([Message.text("thinking"), { type: "tool-call", id: "c1", name: "read", input: {} }])
    const repaired = dropDanglingToolCalls([mixed])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.content).toHaveLength(1)
    expect(repaired[0]!.content[0]!.type).toBe("text")
  })

  test("answered calls untouched", () => {
    const messages = [assistantCall("c1"), toolResult("c1")]
    expect(dropDanglingToolCalls(messages)).toEqual(messages)
  })
})

describe("dropOrphanTools", () => {
  test("drops results whose owning assistant is gone, and empty-id results", () => {
    const kept = [toolResult("c9"), Message.tool({ id: "", name: "x", result: "r" }), user("go")]
    const repaired = dropOrphanTools(kept)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.role).toBe("user")
  })

  test("keeps paired call+result", () => {
    const kept = [assistantCall("c1"), toolResult("c1")]
    expect(dropOrphanTools(kept)).toHaveLength(2)
  })
})

describe("demoteSystemMessages", () => {
  test("mid-history system becomes a provenance-prefixed user message", () => {
    const demoted = demoteSystemMessages([system("env changed")])
    expect(demoted[0]!.role).toBe("user")
    const text = demoted[0]!.content[0]!
    expect(text.type === "text" && text.text.startsWith(SessionInput.STEER_PROVENANCE_PREFIX)).toBe(true)
    // A demoted note must never masquerade as the anchor user message.
    expect(isRealUserMessage(demoted[0]!)).toBe(false)
  })
})

describe("pack", () => {
  test("under budget: returns everything (repairs only)", () => {
    const messages = [user("task"), assistantText("done")]
    const result = pack(messages, 10_000)
    expect(result.messages).toHaveLength(2)
    expect(result.changed).toBe(false)
    expect(result.dropped).toBe(0)
  })

  test("over budget: evicts oldest whole messages, keeps chronology", () => {
    const filler = "x".repeat(4000) // ~1000 tokens each
    const messages = [user("original task"), assistantText(filler), user(filler), assistantText("newest")]
    const result = pack(messages, 1_100)
    expect(result.changed).toBe(true)
    // newest kept; anchor re-prepended
    expect(result.messages[result.messages.length - 1]!.content).toEqual(assistantText("newest").content)
    expect(result.messages.some((m) => isRealUserMessage(m))).toBe(true)
  })

  test("newest message always kept even alone over budget", () => {
    const huge = assistantText("x".repeat(40_000))
    const result = pack([huge], 10)
    expect(result.messages.some((m) => m.role === "assistant")).toBe(true)
  })

  test("anchor: the FIRST real user message is re-prepended when packing would evict it", () => {
    const filler = "y".repeat(8000)
    const messages = [user("the original task"), assistantText(filler), assistantText("recent")]
    const result = pack(messages, 100)
    expect(result.messages[0]!.content).toEqual(user("the original task").content)
  })

  test("anchor skips steers — a nudge never becomes the surviving user message", () => {
    const filler = "z".repeat(8000)
    const messages = [steer("automated nudge"), user("real task"), assistantText(filler), assistantText("recent")]
    const result = pack(messages, 100)
    const first = result.messages[0]!
    expect(isRealUserMessage(first)).toBe(true)
    const text = first.content[0]!
    expect(text.type === "text" && text.text).toBe("real task")
  })

  test("eviction that splits an assistant from its results drops the orphans", () => {
    const filler = "w".repeat(6000)
    // [user, assistant(call), tool(result), assistant(big text)] with a budget that only fits the tail
    const messages = [user("go"), assistantCall("c1"), toolResult("c1"), assistantText(filler), assistantText("tail")]
    const result = pack(messages, 1_600)
    for (const message of result.messages) {
      if (message.role !== "tool") continue
      for (const part of message.content)
        if (part.type === "tool-result") {
          const owned = result.messages.some((m) =>
            m.content.some((p) => p.type === "tool-call" && p.id === part.id),
          )
          expect(owned).toBe(true)
        }
    }
  })

  test("recovers the newest assistant+results group whole when eviction empties the window", () => {
    // Newest message is a lone tool result; its assistant would be evicted -> group recovery.
    const messages = [user("go"), assistantCall("c1"), toolResult("c1", "read", "x".repeat(30_000))]
    const result = pack(messages, 50)
    expect(result.messages.some((m) => m.role === "assistant")).toBe(true)
    expect(
      result.messages.some((m) => m.content.some((p) => p.type === "tool-result" && p.id === "c1")),
    ).toBe(true)
  })
})

describe("ctxPressure", () => {
  test("flags at >=95% of the window", () => {
    expect(ctxPressure(Math.ceil(32_000 * PRESSURE_THRESHOLD), 32_000)).toBe(true)
    expect(ctxPressure(20_000, 32_000)).toBe(false)
    expect(ctxPressure(100, 0)).toBe(false)
  })
})

describe("defaults", () => {
  test("the no-window fallback is conservative, not the model max", () => {
    expect(DEFAULT_CONTEXT_SIZE).toBe(32_000)
  })
})
