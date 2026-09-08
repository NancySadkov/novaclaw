import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { LLM, Message, Model, SystemPart, ToolDefinition } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { SessionInput } from "../input"
import { PromptEstimate } from "./prompt-estimate"
import {
  budget,
  demoteSystemMessages,
  dropDanglingToolCalls,
  dropOrphanTools,
  estimateMessage,
  isRealUserMessage,
  pack,
  packRequest,
  CATEGORY_RECLAMATION_MAX_BAND_TOKENS,
  CATEGORY_RECLAMATION_MIN_BAND_TOKENS,
  categoryReclamationBand,
  DEFAULT_CONTEXT_SIZE,
} from "./context-pack"

const user = (text: string) => Message.user(text)
const steer = (text: string) => Message.user(SessionInput.applySteerProvenance(text))
const assistantText = (text: string) => Message.assistant(text)
const assistantCall = (id: string, name = "read", input: unknown = { path: "a" }) =>
  Message.assistant([{ type: "tool-call", id, name, input }])
const toolResult = (id: string, name = "read", result: unknown = "ok") => Message.tool({ id, name, result })
const system = (text: string) => Message.system(text)
const reasoning = (text: string) => ({ type: "reasoning" as const, text })
/** The NORMAL thinking-model assistant shape: chain-of-thought followed by the call it narrates. */
const assistantThinkCall = (id: string, thought = "let me read it") =>
  Message.assistant([reasoning(thought), { type: "tool-call", id, name: "read", input: { path: "a" } }])

/**
 * An assistant with neither a text part nor a tool call — nothing a wire can render as speech.
 *
 * ⚠️ It no longer lowers the same way everywhere, and the old name for this
 * (`lowersToNullContent`) has stopped being true: `openai-chat` and `openai-compatible-chat` now
 * OMIT such a message outright (`packages/llm/src/protocols/openai-chat.ts`
 * `lowerAssistantMessage`, 2026-07-31 — the answer is per-wire, so the drop lives at the lowering),
 * while `anthropic-messages`, `gemini` and `bedrock-converse` all lower it to a well-formed but
 * semantically EMPTY block. Keeping it off THOSE wires is exactly what this pass is still for, so
 * the two predicates look alike and are not the same check.
 */
const unrenderableAssistant = (message: Message) =>
  message.role === "assistant" &&
  !message.content.some((part) => part.type === "text") &&
  !message.content.some((part) => part.type === "tool-call")

const noSystem: SystemPart[] = []
const noTools: ToolDefinition[] = []
const fakeModel = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })

// Empty tools still stringify to "[]" (~1 token); mirror the impl formula exactly.
const expectedBudget = (contextSize: number, reserve: number, margin = 0) => contextSize - reserve - 1 - margin

describe("budget", () => {
  test("subtracts system, tools, and the shared response reserve", () => {
    const value = budget({ contextSize: 64_000, system: noSystem, tools: noTools })
    // reserve = max(64000/8, 8192) = 8192
    expect(value).toBe(expectedBudget(64_000, PromptEstimate.MIN_RESPONSE_RESERVE))
  })

  test("reserve scales with the window for big contexts", () => {
    const value = budget({ contextSize: 256_000, system: noSystem, tools: noTools })
    expect(value).toBe(expectedBudget(256_000, 25_600))
  })

  test("an explicit maxTokens raises the reserve", () => {
    const value = budget({ contextSize: 64_000, system: noSystem, tools: noTools, maxTokens: 20_000 })
    expect(value).toBe(expectedBudget(64_000, 20_000))
  })

  test("an exact-route prefix-retention hint never narrows semantic history", () => {
    expect(
      budget({
        contextSize: 64_000,
        system: noSystem,
        tools: noTools,
        prefixCacheRetentionTokens: 12_000,
      }),
    ).toBe(expectedBudget(64_000, 8_192))
    expect(
      budget({
        contextSize: 64_000,
        system: noSystem,
        tools: noTools,
        prefixCacheRetentionTokens: 100_000,
      }),
    ).toBe(expectedBudget(64_000, 8_192))
  })

  test("keeps estimation margin separate from response reserve", () => {
    const value = budget({
      contextSize: 64_000,
      system: noSystem,
      tools: noTools,
      maxTokens: 20_000,
      promptMarginTokens: 3_000,
    })
    expect(value).toBe(expectedBudget(64_000, 20_000, 3_000))
  })

  test("a response reserve at least as large as the context leaves no history budget", () => {
    expect(budget({ contextSize: 32_000, system: noSystem, tools: noTools, maxTokens: 32_000 })).toBe(0)
    expect(budget({ contextSize: 32_000, system: noSystem, tools: noTools, maxTokens: 64_000 })).toBe(0)
  })

  test("system and tool text eat the budget, never below zero", () => {
    const bigSystem = [SystemPart.make("x".repeat(400_000))]
    expect(budget({ contextSize: 32_000, system: bigSystem, tools: noTools })).toBe(0)
  })

  test("one image divisor prices nested tool media while text-only system accounting is unchanged", () => {
    const image = {
      type: "media",
      mediaType: "image/png",
      data: readFileSync(
        path.join(import.meta.dir, "..", "..", "..", "..", "app", "public", "assets", "skin", "glyphs", "calendar.png"),
      ).toString("base64"),
    }
    const tools = [
      ToolDefinition.make({
        name: "vision",
        description: "inspect",
        inputSchema: { type: "object" },
        metadata: { example: image },
      }),
    ]
    const base = { contextSize: 64_000, system: [SystemPart.make("same text")], tools }
    expect(budget({ ...base, imagePatchPixels: 16 })).toBeLessThan(budget(base))
    expect(budget({ contextSize: 64_000, system: base.system, tools: noTools, imagePatchPixels: 16 })).toBe(
      budget({ contextSize: 64_000, system: base.system, tools: noTools }),
    )
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
    const mixed = Message.assistant([
      Message.text("thinking"),
      { type: "tool-call", id: "c1", name: "read", input: {} },
    ])
    const repaired = dropDanglingToolCalls([mixed])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.content).toHaveLength(1)
    expect(repaired[0]!.content[0]!.type).toBe("text")
  })

  test("answered calls untouched", () => {
    const messages = [assistantCall("c1"), toolResult("c1")]
    expect(dropDanglingToolCalls(messages)).toEqual(messages)
  })

  // The thinking-model defect: `remaining.length === 0` is not "nothing meaningful remains" — a
  // surviving reasoning part defeats it, and the wreckage then narrates to the provider a call and
  // a result that were BOTH deleted. What that looks like is per-wire: a legal-but-empty `thinking`
  // block on anthropic-messages/gemini/bedrock, and nothing at all on openai-chat, which omits it
  // at the lowering (2026-07-31). The name below is kept because the shape is what matters here.
  test("a reasoning-ONLY remainder is dropped, not sent as content:null", () => {
    const messages = [user("go"), assistantThinkCall("c1")]
    const repaired = dropDanglingToolCalls(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.role).toBe("user")
    expect(repaired.some(unrenderableAssistant)).toBe(false)
  })

  test("multiple reasoning parts around a dangling call still count as nothing renderable", () => {
    const message = Message.assistant([
      reasoning("first"),
      { type: "tool-call", id: "c1", name: "read", input: {} },
      reasoning("second"),
    ])
    expect(dropDanglingToolCalls([message])).toHaveLength(0)
  })

  test("reasoning + text SURVIVES — the text is still renderable", () => {
    const message = Message.assistant([
      reasoning("thinking"),
      Message.text("here is what I found"),
      { type: "tool-call", id: "c1", name: "read", input: {} },
    ])
    const repaired = dropDanglingToolCalls([message])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.content.map((part) => part.type)).toEqual(["reasoning", "text"])
    expect(unrenderableAssistant(repaired[0]!)).toBe(false)
  })

  test("a thinking assistant whose call IS answered is untouched", () => {
    const messages = [user("go"), assistantThinkCall("c1"), toolResult("c1")]
    const repaired = dropDanglingToolCalls(messages)
    expect(repaired).toEqual(messages)
    expect(repaired[1]!.content.map((part) => part.type)).toEqual(["reasoning", "tool-call"])
  })

  test("wire legality: every call answered and every result owned, both paths", () => {
    // c1 dangles (thinking-only assistant -> dropped); c2 is answered and must survive intact.
    const messages = [user("go"), assistantThinkCall("c1"), assistantThinkCall("c2"), toolResult("c2")]
    const repaired = dropOrphanTools(dropDanglingToolCalls(messages))
    const callIds = repaired.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-call" ? [p.id] : [])))
    const resultIds = repaired.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-result" ? [p.id] : [])))
    expect(callIds).toEqual(["c2"])
    expect(resultIds).toEqual(["c2"])
    expect(repaired.some(unrenderableAssistant)).toBe(false)
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

  test("typed tool-output share folds older evidence but keeps the newest result", () => {
    const huge = "tool evidence ".repeat(1_200)
    const messages = [
      user("task"),
      assistantCall("old"),
      toolResult("old", "read", huge),
      assistantCall("new"),
      toolResult("new", "read", huge),
      assistantText("continue"),
    ]
    const result = pack(messages, 100_000, {
      historyCaps: { messages: 100_000, retrieval: 100_000, tool_output: estimateMessage(messages[4]!) + 200 },
    })
    expect(
      result.messages.some((message) =>
        message.content.some((part) => part.type === "tool-result" && part.id === "new" && part.result.value === huge),
      ),
    ).toBe(true)
    expect(
      result.messages.some((message) =>
        message.content.some(
          (part) =>
            part.type === "tool-result" &&
            part.id === "old" &&
            part.result.type === "text" &&
            String(part.result.value).includes("older read tool output omitted"),
        ),
      ),
    ).toBe(true)
    expect(result.findings).toContainEqual({
      kind: "category-budget",
      category: "tool_output",
      limitTokens: expect.any(Number),
      beforeTokens: expect.any(Number),
      afterTokens: expect.any(Number),
      affectedMessages: 1,
      protected: false,
    })
  })

  test("KB retrieval has its own share and does not spend the ordinary tool-output share", () => {
    const huge = "knowledge fact ".repeat(1_200)
    const messages = [
      user("task"),
      assistantCall("kb1", "kb"),
      toolResult("kb1", "kb", huge),
      assistantCall("read1", "read"),
      toolResult("read1", "read", huge),
      assistantText("continue"),
    ]
    const result = pack(messages, 100_000, {
      historyCaps: { messages: 100_000, retrieval: 0, tool_output: 100_000 },
    })
    expect(
      result.findings.some((finding) => finding.kind === "category-budget" && finding.category === "retrieval"),
    ).toBe(true)
    expect(
      result.findings.some((finding) => finding.kind === "category-budget" && finding.category === "tool_output"),
    ).toBe(false)
  })

  test("typed conversation share never evicts the original task or newest message", () => {
    const huge = "conversation ".repeat(1_200)
    const messages = [user("original task"), assistantText(huge), user(huge), assistantText("newest")]
    const result = pack(messages, 100_000, {
      historyCaps: { messages: 100, retrieval: 100_000, tool_output: 100_000 },
    })
    expect(result.messages[0]!.content).toEqual(user("original task").content)
    expect(result.messages.at(-1)!.content).toEqual(assistantText("newest").content)
    expect(result.findings).toContainEqual({
      kind: "category-budget",
      category: "messages",
      limitTokens: 100,
      beforeTokens: expect.any(Number),
      afterTokens: expect.any(Number),
      affectedMessages: 2,
      protected: false,
    })
  })

  test.each([
    ["tool_output", "read"],
    ["retrieval", "kb"],
  ] as const)("%s eviction keeps the packed old prefix byte-identical within one band", (category, name) => {
    const huge = "stable category evidence ".repeat(1_200)
    const initial = [
      user("original task"),
      assistantCall("old", name),
      toolResult("old", name, huge),
      assistantCall("current", name),
      toolResult("current", name, huge),
    ]
    const categoryUsage = initial
      .filter((message) => message.role === "tool")
      .reduce((sum, message) => sum + estimateMessage(message), 0)
    const caps = {
      messages: 100_000,
      retrieval: category === "retrieval" ? categoryUsage - 1 : 100_000,
      tool_output: category === "tool_output" ? categoryUsage - 1 : 100_000,
    }
    const first = pack(initial, 100_000, { historyCaps: caps })
    const growth = [
      assistantCall("next-1", name),
      toolResult("next-1", name, "small one"),
      assistantCall("next-2", name),
      toolResult("next-2", name, "small two"),
    ]
    const grown = pack([...initial, ...growth], 100_000, { historyCaps: caps })

    expect(JSON.stringify(grown.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages))
    const afterUsage = grown.messages
      .filter((message) => message.role === "tool")
      .reduce((sum, message) => sum + estimateMessage(message), 0)
    expect(afterUsage).toBeLessThanOrEqual(caps[category])
    const calls = grown.messages.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])),
    )
    const results = grown.messages.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "tool-result" ? [part.id] : [])),
    )
    expect(results).toEqual(calls)
    expect(results).toContain("next-2")
  })

  test("message eviction keeps the packed old prefix byte-identical within one band", () => {
    const huge = assistantText("stable conversation ".repeat(1_500))
    const initial = [user("original task"), huge, user("prior detail"), assistantText("current answer")]
    const rawUsage = initial.reduce((sum, message) => sum + estimateMessage(message), 0)
    const caps = { messages: rawUsage - 1, retrieval: 100_000, tool_output: 100_000 }
    const first = pack(initial, 100_000, { historyCaps: caps })
    const grown = pack([...initial, assistantText("small growth one"), assistantText("small growth two")], 100_000, {
      historyCaps: caps,
    })

    expect(JSON.stringify(grown.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages))
    expect(grown.messages.reduce((sum, message) => sum + estimateMessage(message), 0)).toBeLessThanOrEqual(caps.messages)
    expect(grown.messages[0]!.content).toEqual(user("original task").content)
    expect(grown.messages.at(-1)!.content).toEqual(assistantText("small growth two").content)
  })

  test("a category frontier advances once when required reclamation crosses one band", () => {
    const huge = "frontier evidence ".repeat(1_200)
    const initial = [
      user("original task"),
      assistantCall("old-1"),
      toolResult("old-1", "read", huge),
      assistantCall("old-2"),
      toolResult("old-2", "read", huge),
      assistantCall("current"),
      toolResult("current", "read", huge),
    ]
    const usage = initial
      .filter((message) => message.role === "tool")
      .reduce((sum, message) => sum + estimateMessage(message), 0)
    const toolCap = Math.floor(usage * 0.75)
    const band = categoryReclamationBand(toolCap)
    const caps = {
      messages: 100_000,
      retrieval: 100_000,
      tool_output: usage - (band - 1),
    }
    const before = pack(initial, 100_000, { historyCaps: caps })
    const after = pack([...initial, assistantCall("next"), toolResult("next", "read", "cross")], 100_000, {
      historyCaps: caps,
    })
    const omitted = (messages: ReadonlyArray<Message>) =>
      messages.filter((message) =>
        message.content.some(
          (part) =>
            part.type === "tool-result" &&
            part.result.type === "text" &&
            String(part.result.value).includes("tool output omitted"),
        ),
      ).length

    expect(omitted(before.messages)).toBe(1)
    expect(omitted(after.messages)).toBe(2)
    expect(after.messages.at(-1)!.content).toEqual(toolResult("next", "read", "cross").content)
    expect(
      after.messages
        .filter((message) => message.role === "tool")
        .reduce((sum, message) => sum + estimateMessage(message), 0),
    ).toBeLessThanOrEqual(caps.tool_output)
  })

  test("reclamation hysteresis scales with long contexts without becoming unbounded", () => {
    expect(categoryReclamationBand(1_000)).toBe(CATEGORY_RECLAMATION_MIN_BAND_TOKENS)
    expect(categoryReclamationBand(104_857)).toBe(Math.floor(104_857 / 4))
    expect(categoryReclamationBand(1_000_000)).toBe(CATEGORY_RECLAMATION_MAX_BAND_TOKENS)
  })

  test("zero and tiny category caps are pure and deterministic while protected anchors survive", () => {
    const messages = [
      user("original task"),
      assistantCall("read-old"),
      toolResult("read-old", "read", "old tool output".repeat(400)),
      assistantCall("kb-old", "kb"),
      toolResult("kb-old", "kb", "old retrieval".repeat(400)),
      assistantCall("read-new"),
      toolResult("read-new", "read", "new tool output"),
      assistantCall("kb-new", "kb"),
      toolResult("kb-new", "kb", "new retrieval"),
      assistantText("newest message"),
    ]
    const raw = JSON.stringify(messages)

    for (const cap of [0, 1]) {
      const historyCaps = { messages: cap, retrieval: cap, tool_output: cap }
      const first = pack(messages, 100_000, { historyCaps })
      const second = pack(messages, 100_000, { historyCaps })
      expect(JSON.stringify(first)).toBe(JSON.stringify(second))
      expect(JSON.stringify(messages)).toBe(raw)
      expect(first.messages[0]!.content).toEqual(user("original task").content)
      expect(first.messages.at(-1)!.content).toEqual(assistantText("newest message").content)
      const calls = first.messages.flatMap((message) =>
        message.content.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])),
      )
      const results = first.messages.flatMap((message) =>
        message.content.flatMap((part) => (part.type === "tool-result" ? [part.id] : [])),
      )
      expect(results).toEqual(calls)
      expect(results).toContain("read-new")
      expect(results).toContain("kb-new")
      expect(
        first.findings
          .filter((finding) => finding.kind === "category-budget")
          .every((finding) => finding.protected),
      ).toBe(true)
    }
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

  test("zero-user transcript: never fabricates a task or renderable placeholder", () => {
    // This is the exact boundary behind the packages/llm empty-conversation ruling. A lone
    // reasoning assistant is legal on some wires and omitted on others; pack cannot know which.
    // Its obligation is narrower and mechanical: preserve/evict real transcript messages only,
    // never synthesize user speech to make the output appear renderable.
    const only = Message.assistant([reasoning("private chain of thought")])
    const input = [only]
    const result = pack(input, 1)

    expect(result.messages).toEqual([only])
    expect(result.messages[0]).toBe(only)
    expect(result.messages.every((message) => input.includes(message))).toBe(true)
    expect(result.messages.some((message) => message.role === "user")).toBe(false)
    expect(result.messages.some((message) => message.content.some((part) => part.type === "text"))).toBe(false)
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
          const owned = result.messages.some((m) => m.content.some((p) => p.type === "tool-call" && p.id === part.id))
          expect(owned).toBe(true)
        }
    }
  })

  test("the abort-mid-tool tail never packs a content:null assistant", () => {
    // Newest turn: the model thought, called a tool, and was aborted before the result existed.
    const messages = [user("original task"), assistantText("ok"), assistantThinkCall("c1")]
    const result = pack(messages, 10_000)
    expect(result.messages.some(unrenderableAssistant)).toBe(false)
    expect(result.changed).toBe(true)
    expect(result.messages.some(isRealUserMessage)).toBe(true)
  })

  test("over budget with a thinking tail: still no content:null assistant survives", () => {
    const filler = "q".repeat(8000)
    const messages = [user("original task"), assistantText(filler), assistantThinkCall("c1")]
    const result = pack(messages, 100)
    expect(result.messages.some(unrenderableAssistant)).toBe(false)
    // The anchor still survives even though the tail was dropped entirely.
    expect(result.messages.some(isRealUserMessage)).toBe(true)
  })

  test("recovers the newest assistant+results group whole when eviction empties the window", () => {
    // Newest message is a lone tool result; its assistant would be evicted -> group recovery.
    const messages = [user("go"), assistantCall("c1"), toolResult("c1", "read", "x".repeat(30_000))]
    const result = pack(messages, 50)
    expect(result.messages.some((m) => m.role === "assistant")).toBe(true)
    expect(result.messages.some((m) => m.content.some((p) => p.type === "tool-result" && p.id === "c1"))).toBe(true)
  })
})

describe("packRequest typed system shares", () => {
  test("applies an anchored correction once at the overall history boundary", () => {
    const request = LLM.request({
      model: fakeModel,
      messages: [assistantText("a".repeat(5_000)), assistantText("b".repeat(5_000)), user("c".repeat(5_000))],
    })
    const ordinary = packRequest({ request, contextSize: 12_000 })
    const undercount = packRequest({ request, contextSize: 12_000, promptCorrectionTokens: 1_500 })
    const overcount = packRequest({ request, contextSize: 12_000, promptCorrectionTokens: -1_500 })
    expect(ordinary.dropped).toBe(1)
    expect(undercount.dropped).toBe(2)
    expect(overcount.dropped).toBe(0)
  })

  // Auto-recall lives in the message TAIL since 2026-08-05 (system-compose.ts's ⚠️ header): in the
  // system array it was the one per-turn-volatile part and it invalidated the server-side prefix
  // cache for the whole request. The `memory` category budget followed it, so this asserts the
  // trimming against a tail MESSAGE — and that nothing puts recall back into the system prompt.
  test("memory is line-trimmed in the message tail while an oversized system prompt is protected", () => {
    const memory = `Remember these:\n${Array.from({ length: 20 }, (_, index) => `- fact ${index} ${"x".repeat(80)}`).join("\n")}`
    const request = LLM.request({
      model: fakeModel,
      system: [SystemPart.make("kernel instruction ".repeat(300))],
      messages: [user("task"), user(memory)],
    })
    const result = packRequest({
      request,
      contextSize: 10_000,
      memoryRecall: memory,
      profile: { system: 1, messages: 40, retrieval: 10, memory: 1, tool_output: 20 },
    })
    // Never in the system prompt — that is the whole point of the move.
    expect(result.system.some((part) => part.text === memory)).toBe(false)
    // Present but TRIMMED: the full block is gone, a shorter prefix of it survives.
    const memoryTexts = result.messages.flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "text" && part.text.startsWith("Remember these:") ? [part.text] : [],
      ),
    )
    expect(memoryTexts).toHaveLength(1)
    expect(memoryTexts[0]!.length).toBeLessThan(memory.length)
    expect(result.findings).toContainEqual({
      kind: "category-budget",
      category: "system",
      limitTokens: 100,
      beforeTokens: expect.any(Number),
      afterTokens: expect.any(Number),
      affectedMessages: 0,
      protected: true,
    })
    expect(result.findings).toContainEqual({
      kind: "category-budget",
      category: "memory",
      limitTokens: 100,
      beforeTokens: expect.any(Number),
      afterTokens: expect.any(Number),
      affectedMessages: 1,
      protected: false,
    })
  })

  // The property that makes tail injection SAFE. Auto-recall now rides the `user` role, and the
  // packer's anchor (`isRealUserMessage`) is what survives eviction — so a bare recall block would
  // be eligible to become "the user's message" and outlive the real one. The 1N provenance prefix
  // is what prevents that, exactly as it does for the todo reminder and every steer.
  test("a tail-injected recall block is not mistaken for the user speaking", () => {
    const recall = SessionInput.applySteerProvenance("Relevant things you remember:\n- prefers tabs")
    expect(isRealUserMessage(user(recall))).toBe(false)
    // …and the real turn still anchors.
    const messages = [user("the real task"), user(recall)]
    expect(messages.findIndex(isRealUserMessage)).toBe(0)
  })
})

describe("defaults", () => {
  test("the no-window fallback is conservative, not the model max", () => {
    expect(DEFAULT_CONTEXT_SIZE).toBe(32_000)
  })
})

/**
 * ── WHAT THE PACKER KEEPS WHEN THE HISTORY IS PICTURES ───────────────────────────────────────────
 *
 * 🔴 `estimateMessage` priced a base64 image by its CHARACTER LENGTH until 2026-08-29: one real
 * corpus icon scored thousands of tokens where the provider charges a measured **66**. The packer
 * budgets on that number, so an image-reading session had its history dropped for room that was
 * never occupied.
 *
 * ⚠️ This asserts what `pack` KEEPS, not what `estimateMessage` returns. The estimate is pinned in
 * `test/media-estimate-all-sites.test.ts`; a number is not a decision, and this suite's 34 other
 * tests stay green with the media charge removed entirely — so nothing here covered the behaviour
 * that number drives.
 */
describe("image history is not evicted for space it never used", () => {
  const IMAGE_B64 = readFileSync(
    path.join(import.meta.dir, "..", "..", "..", "..", "app", "public", "assets", "skin", "glyphs", "calendar.png"),
  ).toString("base64")
  const imageResult = (id: string) =>
    Message.tool({
      id,
      name: "read",
      result: [
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${IMAGE_B64}`, mime: "image/png", name: `${id}.png` },
      ],
    })

  /** Six read calls and their image results — 396 provider tokens, once 70,632 by the old estimate. */
  const sixImages = () => {
    const messages = [user("describe every icon")]
    for (let index = 0; index < 6; index++) {
      messages.push(assistantCall(`c${index}`, "read", { path: `icon-${index}.png` }))
      messages.push(imageResult(`c${index}`))
    }
    return messages
  }

  test("six real images fit a 20,000-token budget — the old estimate called them over 40,000", () => {
    const result = pack(sixImages(), 20_000)
    expect(result.dropped, "nothing should be dropped: this is ~400 provider tokens").toBe(0)
    expect(result.changed).toBe(false)
  })

  // ⚠️ THE CONTROL. Without it this passes just as well if `pack` stopped evicting anything at all.
  test("but six equally-large TEXT results still overflow the same budget", () => {
    const messages = [user("read every file")]
    for (let index = 0; index < 6; index++) {
      messages.push(assistantCall(`t${index}`))
      messages.push(toolResult(`t${index}`, "read", "o".repeat(47_000)))
    }
    const result = pack(messages, 20_000)
    expect(result.changed, "70,000 tokens of real text must still be packed down").toBe(true)
  })

  test("a smaller route patch changes media estimates and eviction, while text-only packing is identical", () => {
    const images = sixImages()
    const ordinaryTokens = images.reduce((sum, message) => sum + estimateMessage(message), 0)
    const denseTokens = images.reduce((sum, message) => sum + estimateMessage(message, 16), 0)
    const boundary = Math.floor((ordinaryTokens + denseTokens) / 2)

    expect(denseTokens).toBeGreaterThan(ordinaryTokens)
    expect(pack(images, boundary).dropped).toBe(0)
    expect(pack(images, boundary, { imagePatchPixels: 16 }).dropped).toBeGreaterThan(0)

    const text = [user("task"), assistantText("x".repeat(4_000)), assistantText("done")]
    expect(pack(text, 1_000, { imagePatchPixels: 16 })).toEqual(pack(text, 1_000))
  })

  test("packRequest applies the same image divisor used by direct message estimates", () => {
    const request = LLM.request({ model: fakeModel, messages: sixImages() })
    const ordinary = packRequest({ request, contextSize: 10_000 })
    const dense = packRequest({ request, contextSize: 10_000, imagePatchPixels: 16 })
    expect(dense.dropped).toBeGreaterThan(ordinary.dropped)
    expect(ordinary.estimatedTokens).toBe(ordinary.messages.reduce((sum, message) => sum + estimateMessage(message), 0))
    expect(dense.estimatedTokens).toBe(dense.messages.reduce((sum, message) => sum + estimateMessage(message, 16), 0))
  })
})
