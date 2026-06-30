import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, type LLMRequest } from "../schema"
import { OpenAIChat } from "./openai-chat"

// `initial` only reads `request.tools`, so a minimal cast is enough to drive the
// real protocol state machine (initial -> step* -> onHalt) without a live model.
const request = (tools: string[]) => ({ tools: tools.map((name) => ({ name })) }) as unknown as LLMRequest

function decode(tools: string[], events: ReadonlyArray<Record<string, unknown>>): LLMEvent[] {
  let state = OpenAIChat.protocol.stream.initial(request(tools))
  const emitted: LLMEvent[] = []
  for (const event of events) {
    const [next, produced] = Effect.runSync(OpenAIChat.protocol.stream.step(state, event as never))
    state = next
    emitted.push(...produced)
  }
  emitted.push(...(OpenAIChat.protocol.stream.onHalt?.(state) ?? []))
  return emitted
}

const text = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] })
const stop = { choices: [{ delta: {}, finish_reason: "stop" }] }
const structuredCall = (name: string, args: string) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] }, finish_reason: null }],
})

const toolCalls = (events: LLMEvent[]) => events.filter(LLMEvent.is.toolCall)
const finishReason = (events: LLMEvent[]) => events.find(LLMEvent.is.finish)?.reason

describe("openai-chat — text-dumped tool-call recovery (A2 wiring)", () => {
  test("recovers a hermes <tool_call> dumped into text + continues the loop", () => {
    const events = decode(
      ["read", "bash"],
      [text('<tool_call>{"name":"read","arguments":{"filePath":"a.ts"}}</tool_call>'), stop],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("read")
    expect(calls[0].input).toEqual({ filePath: "a.ts" })
    // the loop must NOT halt: finish="stop" is rewritten to "tool-calls"
    expect(finishReason(events)).toBe("tool-calls")
  })

  test("recovers a call split across deltas (streaming fragmentation)", () => {
    const events = decode(
      ["read"],
      [text('<tool_call>{"name":"re'), text('ad","arguments":{"filePath":"a.ts"}}</tool_call>'), stop],
    )
    expect(toolCalls(events).map((c) => c.name)).toEqual(["read"])
    expect(finishReason(events)).toBe("tool-calls")
  })

  test("canonicalizes a recovered name (Read -> read)", () => {
    const events = decode(["read"], [text('<tool_call>{"name":"Read","arguments":{"filePath":"a"}}</tool_call>'), stop])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["read"])
  })

  test("ordinary prose is NOT misread as a call", () => {
    const events = decode(["read", "bash"], [text("Sure — I'll read the file and run a quick check."), stop])
    expect(toolCalls(events).length).toBe(0)
    expect(finishReason(events)).toBe("stop")
  })

  test("prose with angle brackets (C++) is NOT misread", () => {
    const events = decode(["read"], [text("Use `std::vector<int> v;` then `v.push_back(1);`."), stop])
    expect(toolCalls(events).length).toBe(0)
    expect(finishReason(events)).toBe("stop")
  })
})

describe("openai-chat — structured tool calls unaffected", () => {
  test("a normal structured call still decodes", () => {
    const events = decode(
      ["read"],
      [structuredCall("read", '{"filePath":"a.ts"}'), { choices: [{ delta: {}, finish_reason: "tool_calls" }] }],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("read")
    expect(calls[0].input).toEqual({ filePath: "a.ts" })
  })

  test("structured call reporting finish=stop is still rewritten to tool-calls", () => {
    const events = decode(["read"], [structuredCall("read", '{"filePath":"a.ts"}'), stop])
    expect(toolCalls(events).length).toBe(1)
    expect(finishReason(events)).toBe("tool-calls")
  })
})
