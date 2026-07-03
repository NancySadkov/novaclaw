import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, type LLMRequest } from "../schema"
import { OpenAIChat } from "./openai-chat"
import { TRUNCATED_ARGS_SENTINEL, truncatedArgsMessage } from "./utils/truncated-args"

// Drive the real protocol state machine (initial -> step* -> onHalt) with no live model.
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

const startCall = (name: string) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] }, finish_reason: null }],
})
const argsDelta = (args: string) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }],
})
const length = { choices: [{ delta: {}, finish_reason: "length" }] }
const toolCalls = (events: LLMEvent[]) => events.filter(LLMEvent.is.toolCall)

describe("openai-chat — truncated streamed args self-repair (1O/A4)", () => {
  test("a write whose args truncate at the token limit emits a recoverable sentinel, not a halt", () => {
    // The classic case: a large write whose streamed JSON is cut off before it closes, then the
    // server reports finish_reason=length. Previously the parse failure failed the whole stream.
    let events: LLMEvent[] = []
    expect(() => {
      events = decode(["write"], [startCall("write"), argsDelta('{"path":"out.txt","content":"aaaa'), length])
    }).not.toThrow()
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("write")
    // the sentinel rides as the call input so the settle path can lower it into the prescriptive result
    expect(truncatedArgsMessage(calls[0].input)).toBeDefined()
    expect(Object.keys(calls[0].input as object)).toEqual([TRUNCATED_ARGS_SENTINEL])
  })

  test("a fragment split across deltas is accumulated by index before the parse attempt", () => {
    let events: LLMEvent[] = []
    expect(() => {
      events = decode(
        ["write"],
        [startCall("write"), argsDelta('{"path":"a",'), argsDelta('"content":"zzzz'), length],
      )
    }).not.toThrow()
    expect(toolCalls(events).length).toBe(1)
    expect(truncatedArgsMessage(toolCalls(events)[0].input)).toBeDefined()
  })

  test("a COMPLETE structured call is unaffected — no sentinel, real input decoded", () => {
    const events = decode(
      ["write"],
      [startCall("write"), argsDelta('{"path":"a.ts","content":"ok"}'), length],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(truncatedArgsMessage(calls[0].input)).toBeUndefined()
    expect(calls[0].input).toEqual({ path: "a.ts", content: "ok" })
  })
})

const tool_calls = { choices: [{ delta: {}, finish_reason: "tool_calls" }] }

describe("openai-chat — tool-call id hardening (1O/A4 adjacent)", () => {
  test("a missing tool_call_id is synthesized, never halts, never empty", () => {
    const events = decode(
      ["read"],
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"path":"a"}' } }] }, finish_reason: null }] },
        tool_calls,
      ],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].id.length).toBeGreaterThan(0)
    expect(calls[0].input).toEqual({ path: "a" })
  })

  test("an EMPTY tool_call_id is treated as missing (an empty id 400s the next request)", () => {
    const events = decode(
      ["read"],
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "", function: { name: "read", arguments: '{"path":"a"}' } }] }, finish_reason: null }] },
        tool_calls,
      ],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].id.length).toBeGreaterThan(0)
  })

  test("identity is pinned once started — a late conflicting id does not fork the call", () => {
    const events = decode(
      ["read"],
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_real", function: { name: "read", arguments: '{"pa' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_other", function: { arguments: 'th":"a"}' } }] }, finish_reason: null }] },
        tool_calls,
      ],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].id).toBe("call_real")
    expect(calls[0].input).toEqual({ path: "a" })
  })

  test("a real id arriving on a later fragment is used when the first fragment lacked one… identity stays stable", () => {
    // First fragment: name only (id synthesized). Later fragment brings an id — pinned identity wins,
    // so the synthesized id is kept (events already streamed under it).
    const events = decode(
      ["read"],
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"pa' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_late", function: { arguments: 'th":"a"}' } }] }, finish_reason: null }] },
        tool_calls,
      ],
    )
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].id).toBe("call_stream_0")
    expect(calls[0].input).toEqual({ path: "a" })
  })
})
