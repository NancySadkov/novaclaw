import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, type LLMRequest } from "../schema"
import { OpenAIChat } from "./openai-chat"
import { truncatedArgsMessage } from "./utils/truncated-args"

// A stream that ends BEFORE its terminal event. Drives the real protocol state machine
// (initial -> step* -> onHalt) with no live model, exactly as the sibling decoder suites do; the
// cut is modelled by simply not feeding the chunk that carries `finish_reason`.
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

const startCall = (name: string, args = "") => ({
  choices: [
    { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] }, finish_reason: null },
  ],
})
const argsDelta = (args: string) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }],
})
const text = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] })
const terminal = { choices: [{ delta: {}, finish_reason: "tool_calls" }] }

const toolCalls = (events: LLMEvent[]) => events.filter(LLMEvent.is.toolCall)
const finishes = (events: LLMEvent[]) => events.filter(LLMEvent.is.stepFinish)

describe("openai-chat — a stream cut before its terminal event", () => {
  test("a COMPLETE structured call whose stream ends with no finish_reason is still delivered, and the turn closes", () => {
    const events = decode(["read"], [startCall("read"), argsDelta('{"path":"a.ts"}')])
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("read")
    expect(calls[0].input).toEqual({ path: "a.ts" })
    // The turn CLOSES, and it closes as work to do rather than as a completion.
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(events.filter(LLMEvent.is.finish).length).toBe(1)
    // and the call is well formed: one start, one end, one call, in order
    expect(events.filter(LLMEvent.is.toolInputStart).length).toBe(1)
    expect(events.filter(LLMEvent.is.toolInputEnd).length).toBe(1)
  })

  test("a call whose ARGUMENTS were cut mid-object rides the recoverable sentinel instead of vanishing", () => {
    const events = decode(["write"], [startCall("write"), argsDelta('{"path":"out.txt","content":"aaaa')])
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("write")
    expect(truncatedArgsMessage(calls[0].input)).toBeDefined()
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
  })

  test("a TEXT-only turn cut before its terminal event closes naming a fault, with its text block ended", () => {
    const events = decode(["read"], [text("partial ans")])
    expect(toolCalls(events).length).toBe(0)
    // ruling 2 — the turn is closed, and it is not described as a completion
    expect(finishes(events).map((event) => event.reason)).toEqual(["error"])
    expect(events.filter(LLMEvent.is.textEnd).length).toBe(1)
  })

  test("a stream that produced NOTHING is left to the runner's empty-response fault, not closed here", () => {
    // Synthesizing a settlement for an empty body would mint an empty assistant message alongside
    // the named InvalidProviderOutput the runner already publishes for this exact case.
    expect(decode(["read"], [])).toEqual([])
  })
})

describe("openai-chat — the HEALTHY path is untouched (negative control for the cut-stream close)", () => {
  test("the same stream WITH its terminal event behaves exactly as before — one call, one finish", () => {
    const cut = decode(["read"], [startCall("read"), argsDelta('{"path":"a.ts"}')])
    const whole = decode(["read"], [startCall("read"), argsDelta('{"path":"a.ts"}'), terminal])
    const calls = toolCalls(whole)
    expect(calls.length).toBe(1)
    expect(calls[0].input).toEqual({ path: "a.ts" })
    expect(finishes(whole).map((event) => event.reason)).toEqual(["tool-calls"])
    // The flush must not DUPLICATE a call the terminal event already finalized.
    expect(whole.filter(LLMEvent.is.toolInputEnd).length).toBe(1)
    // Same event tape either way: the fix adds the missing close, it does not change a served turn.
    expect(whole.map((event) => event.type)).toEqual(cut.map((event) => event.type))
  })

  test("a plain text turn WITH finish_reason=stop still finishes as \"stop\"", () => {
    const events = decode(["read"], [text("hello"), { choices: [{ delta: {}, finish_reason: "stop" }] }])
    expect(finishes(events).map((event) => event.reason)).toEqual(["stop"])
    expect(toolCalls(events).length).toBe(0)
  })

  test("finish_reason=stop alongside a text-dumped call still synthesizes \"tool-calls\"", () => {
    const dumped = '<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>'
    const events = decode(["read"], [text(dumped), { choices: [{ delta: {}, finish_reason: "stop" }] }])
    expect(toolCalls(events).length).toBe(1)
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
  })
})
