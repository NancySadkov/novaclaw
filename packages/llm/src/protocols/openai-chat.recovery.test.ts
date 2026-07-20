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

const reasoning = (content: string) => ({ choices: [{ delta: { reasoning_content: content }, finish_reason: null }] })

// The live 2026-07-21 doom-loop signature (issues.md mask-token P2): the thinking model
// leaves the complete call in the REASONING channel while the visible text is only leaked
// mask-token debris. Scavenging reasoning is the LAST resort — gated on the text carrying
// no answer at all.
describe("openai-chat — reasoning-channel scavenge", () => {
  test("call in reasoning + mask-debris text recovers and continues the loop", () => {
    const events = decode(
      ["write", "read"],
      [
        reasoning('I need to create the file. write(path="perm-test.txt", content="hello")'),
        text("\n\n<|mask_start|><think>\n\n<|mask_end|>"),
        stop,
      ],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("write")
    expect(calls[0].input).toEqual({ path: "perm-test.txt", content: "hello" })
    expect(finishReason(events)).toBe("tool-calls")
  })

  test("reasoning is NOT scavenged when the text carries a real answer", () => {
    const events = decode(
      ["write"],
      [reasoning('Maybe I could call write(path="x", content="y") here.'), text("Here is my final answer: 42."), stop],
    )
    expect(toolCalls(events).length).toBe(0)
    expect(finishReason(events)).toBe("stop")
  })

  test("reasoning prose without a structured call recovers nothing", () => {
    const events = decode(
      ["write"],
      [reasoning("The user wants a file created. I should use the write tool for this."), text("<|mask_start|>"), stop],
    )
    expect(toolCalls(events).length).toBe(0)
  })

  test("text-recovered call wins over reasoning content", () => {
    const events = decode(
      ["write", "read"],
      [
        reasoning('First I considered read(filePath="other.ts").'),
        text("<write><parameter=path>a.txt</parameter></write>"),
        stop,
      ],
    )
    expect(toolCalls(events).map((c) => c.name)).toEqual(["write"])
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

const toolCalls_ = { choices: [{ delta: {}, finish_reason: "tool_calls" }] }

describe("openai-chat — structured tool-name canonicalization (A1)", () => {
  test("case mismatch is canonicalized (Write -> write)", () => {
    const events = decode(["write", "read"], [structuredCall("Write", '{"filePath":"a"}'), toolCalls_])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["write"])
  })

  test("near-typo is canonicalized (apply_path -> apply_patch)", () => {
    const events = decode(["apply_patch", "read"], [structuredCall("apply_path", '{"patch":"x"}'), toolCalls_])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["apply_patch"])
  })

  test("an unknown structured name passes through unchanged (runner surfaces it, decoder doesn't drop)", () => {
    const events = decode(["read"], [structuredCall("frobnicate", "{}"), toolCalls_])
    expect(toolCalls(events).map((c) => c.name)).toEqual(["frobnicate"])
  })
})
