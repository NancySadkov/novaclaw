import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { LLMEvent, type LLMRequest } from "../schema"
import { AnthropicMessages } from "./anthropic-messages"
import { Gemini } from "./gemini"
import { OpenAIChat } from "./openai-chat"
import { OpenAIResponses } from "./openai-responses"

// A stream that ends BEFORE its terminal event, driven through the real protocol state machines
// (initial -> step* -> onHalt) with no live model, exactly as `openai-chat.cut-stream.test.ts` does
// for the fourth wire. The cut is modelled by simply not feeding the terminal chunk.
interface Streamable {
  readonly initial: (request: never) => unknown
  readonly step: (state: never, event: never) => Effect.Effect<readonly [unknown, ReadonlyArray<LLMEvent>], unknown>
  readonly terminal?: (event: never) => boolean
  readonly onHalt?: (state: never) => ReadonlyArray<LLMEvent>
}

const request = { tools: [] } as unknown as LLMRequest

function decode(stream: Streamable, events: ReadonlyArray<Record<string, unknown>>): LLMEvent[] {
  let state = stream.initial(request as never)
  const emitted: LLMEvent[] = []
  for (const event of events) {
    const [next, produced] = Effect.runSync(stream.step(state as never, event as never))
    state = next
    emitted.push(...produced)
    // `Stream.takeUntil` keeps the matching element and then ends the stream, so a terminal event is
    // stepped and nothing after it is — the halt runs next. Modelled here so the settled-turn cases
    // exercise the same order production does.
    if (stream.terminal?.(event as never)) break
  }
  emitted.push(...(stream.onHalt?.(state as never) ?? []))
  return emitted
}

const types = (events: ReadonlyArray<LLMEvent>) => events.map((event) => event.type)
const toolCalls = (events: ReadonlyArray<LLMEvent>) => events.filter(LLMEvent.is.toolCall)
const finishes = (events: ReadonlyArray<LLMEvent>) => events.filter(LLMEvent.is.stepFinish)

// =============================================================================
// The class ratchet
// =============================================================================
const PROTOCOLS = [
  ["anthropic-messages", AnthropicMessages.protocol],
  ["gemini", Gemini.protocol],
  ["openai-chat", OpenAIChat.protocol],
  ["openai-responses", OpenAIResponses.protocol],
] as const

describe("every protocol answers the end of its stream", () => {
  // ⚠️ `ProtocolStream.onHalt` is OPTIONAL, and two of four protocols silently declined to answer
  // it: a stream cut before its terminal event left their blocks open, dropped their pending tool
  // calls, and — because the stream SUCCEEDED — handed the layer above no error either. Optional is
  // what made that invisible, so this list is the ratchet: a protocol added without a halt flush
  // fails HERE rather than in a session a year from now. The stronger rung (a required field on
  // `ProtocolStream`, the way `body.conversation` is required) is a change to `route/protocol.ts`.
  test.each(PROTOCOLS)("%s declares a halt flush", (_id, protocol) => {
    expect(typeof protocol.stream.onHalt).toBe("function")
  })

  test("⛔ a protocol added without a halt flush fails HERE, by name", () => {
    // The list above is hand-written, so this is what stops it going stale — the same structural
    // discovery `prompted-tools-coverage.test.ts` uses, and for the same reason: a guard whose scope
    // you curate is a guard that agrees with you. A module that calls `Protocol.make(` is a wire.
    const dir = path.resolve(import.meta.dir)
    const modules = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
      .filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes("Protocol.make("))
      .map((name) => name.replace(/\.ts$/, ""))
    expect(modules.sort()).toEqual(PROTOCOLS.map(([id]) => id).sort())
  })

  // The flush must be a PURE (state) => events: it runs from `Stream.mapAccumEffect`'s halt arm,
  // including its failure arm, where there is no Effect to run.
  test.each(PROTOCOLS)("%s halts on a stream that produced NOTHING without inventing a turn", (_id, protocol) => {
    // Synthesizing a settlement for an empty body would mint an empty assistant message alongside
    // the named InvalidProviderOutput the runner already publishes for this exact case.
    expect(decode(protocol.stream as unknown as Streamable, [])).toEqual([])
  })
})

// =============================================================================
// anthropic-messages
// =============================================================================
const anthropic = AnthropicMessages.protocol.stream as unknown as Streamable

const anthropicThinking = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "hm" } }
const anthropicToolStart = {
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "toolu_1", name: "read" },
}
const anthropicArgs = (json: string) => ({
  type: "content_block_delta",
  index: 1,
  delta: { type: "input_json_delta", partial_json: json },
})
const anthropicToolStop = { type: "content_block_stop", index: 1 }
const anthropicEnd = { type: "message_delta", delta: { stop_reason: "tool_use" } }

describe("anthropic-messages — a stream cut before its terminal event", () => {
  test("a thinking block cut mid-stream is CLOSED, and the turn closes naming a fault", () => {
    const events = decode(anthropic, [anthropicThinking])
    expect(types(events)).toEqual([
      "step-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "step-finish",
      "finish",
    ])
    // ruling 2 — the turn is closed, and it is not described as a completion
    expect(finishes(events).map((event) => event.reason)).toEqual(["error"])
  })

  test("a COMPLETE tool_use whose stream ends with no message_delta is still delivered, and the turn closes", () => {
    const events = decode(anthropic, [anthropicToolStart, anthropicArgs('{"path":"a.ts"}')])
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe("read")
    expect(calls[0].input).toEqual({ path: "a.ts" })
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(events.filter(LLMEvent.is.toolInputStart).length).toBe(1)
    expect(events.filter(LLMEvent.is.toolInputEnd).length).toBe(1)
  })

  test("a call ALREADY finalized by content_block_stop still closes the turn as work to do", () => {
    // The accumulator is drained by `content_block_stop`, so the halt recovers nothing here and the
    // "did we get any calls" question cannot be answered from `tools`. Closing this as `"error"`
    // would tell the runner nothing was delivered and make it continue a request already made.
    const events = decode(anthropic, [anthropicToolStart, anthropicArgs('{"path":"a.ts"}'), anthropicToolStop])
    expect(toolCalls(events).length).toBe(1)
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(events.filter(LLMEvent.is.finish).length).toBe(1)
  })

  test("a tool_use whose ARGUMENTS were cut mid-object rides the recoverable sentinel instead of vanishing", () => {
    const events = decode(anthropic, [anthropicToolStart, anthropicArgs('{"path":"out.txt","content":"aaaa')])
    expect(toolCalls(events).length).toBe(1)
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
  })
})

describe("anthropic-messages — the SETTLED turn is untouched (negative control)", () => {
  test("the same stream WITH its terminal event behaves exactly as before — one call, one finish", () => {
    const cut = decode(anthropic, [anthropicToolStart, anthropicArgs('{"path":"a.ts"}')])
    const whole = decode(anthropic, [
      anthropicToolStart,
      anthropicArgs('{"path":"a.ts"}'),
      anthropicToolStop,
      anthropicEnd,
    ])
    expect(toolCalls(whole).length).toBe(1)
    expect(toolCalls(whole)[0].input).toEqual({ path: "a.ts" })
    expect(finishes(whole).map((event) => event.reason)).toEqual(["tool-calls"])
    // The halt must not DUPLICATE a call, a close, or a finish the terminal event already emitted.
    expect(whole.filter(LLMEvent.is.toolInputEnd).length).toBe(1)
    expect(whole.filter(LLMEvent.is.finish).length).toBe(1)
    // Same event tape either way: the fix adds the missing close, it does not change a served turn.
    expect(types(whole)).toEqual(types(cut))
  })

  test("a settled thinking turn is closed ONCE, by message_delta and not again by the halt", () => {
    const events = decode(anthropic, [
      anthropicThinking,
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ])
    expect(events.filter(LLMEvent.is.finish).length).toBe(1)
    expect(events.filter(LLMEvent.is.reasoningEnd).length).toBe(1)
    expect(finishes(events).map((event) => event.reason)).toEqual(["stop"])
  })

  test("a NAMED stream error is not followed by a synthesized second ending", () => {
    const events = decode(anthropic, [
      anthropicThinking,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ])
    expect(events.filter(LLMEvent.is.providerError).length).toBe(1)
    expect(events.filter(LLMEvent.is.finish).length).toBe(0)
  })
})

// =============================================================================
// openai-responses
// =============================================================================
const responses = OpenAIResponses.protocol.stream as unknown as Streamable

const responsesReasoning = {
  type: "response.output_item.added",
  item: { type: "reasoning", id: "rs_1", summary: [] },
}
const responsesToolStart = {
  type: "response.output_item.added",
  item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
}
const responsesArgs = (json: string) => ({
  type: "response.function_call_arguments.delta",
  item_id: "fc_1",
  delta: json,
})
const responsesToolDone = {
  type: "response.output_item.done",
  item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
}
const responsesCompleted = { type: "response.completed", response: { id: "resp_1" } }

describe("openai-responses — a stream cut before its terminal event", () => {
  test("an ACTIVE reasoning summary part cut mid-stream is CLOSED, and the turn closes naming a fault", () => {
    const events = decode(responses, [
      responsesReasoning,
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "hm" },
    ])
    expect(types(events)).toEqual([
      "step-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "step-finish",
      "finish",
    ])
    expect(finishes(events).map((event) => event.reason)).toEqual(["error"])
  })

  test("a COMPLETE function call whose stream ends with no response.completed is still delivered", () => {
    const events = decode(responses, [responsesToolStart, responsesArgs('{"path":"a.ts"}')])
    const calls = toolCalls(events)
    expect(calls.length).toBe(1)
    expect(calls[0].id).toBe("call_1")
    expect(calls[0].input).toEqual({ path: "a.ts" })
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(events.filter(LLMEvent.is.toolInputEnd).length).toBe(1)
  })

  test("a call ALREADY finalized by output_item.done still closes the turn as work to do", () => {
    const events = decode(responses, [responsesToolStart, responsesArgs('{"path":"a.ts"}'), responsesToolDone])
    expect(toolCalls(events).length).toBe(1)
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(events.filter(LLMEvent.is.finish).length).toBe(1)
  })
})

describe("openai-responses — the SETTLED turn is untouched (negative control)", () => {
  test("the same stream WITH response.completed behaves exactly as before — one call, one finish", () => {
    const cut = decode(responses, [responsesToolStart, responsesArgs('{"path":"a.ts"}')])
    const whole = decode(responses, [
      responsesToolStart,
      responsesArgs('{"path":"a.ts"}'),
      responsesToolDone,
      responsesCompleted,
    ])
    expect(toolCalls(whole).length).toBe(1)
    expect(toolCalls(whole)[0].input).toEqual({ path: "a.ts" })
    expect(finishes(whole).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(whole.filter(LLMEvent.is.toolInputEnd).length).toBe(1)
    expect(whole.filter(LLMEvent.is.finish).length).toBe(1)
    expect(types(whole)).toEqual(types(cut))
  })

  test("a NAMED response.failed is not followed by a synthesized second ending", () => {
    const events = decode(responses, [
      responsesReasoning,
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "hm" },
      { type: "response.failed", response: { error: { code: "server_error", message: "boom" } } },
    ])
    expect(events.filter(LLMEvent.is.providerError).length).toBe(1)
    expect(events.filter(LLMEvent.is.finish).length).toBe(0)
  })
})

// =============================================================================
// gemini
// =============================================================================
const gemini = Gemini.protocol.stream as unknown as Streamable

const geminiPart = (part: Record<string, unknown>) => ({
  candidates: [{ content: { role: "model", parts: [part] } }],
})
const geminiEnd = { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] }

describe("gemini — a stream cut before its terminal event", () => {
  test("a thought part cut mid-stream is CLOSED, and the turn closes naming a fault", () => {
    const events = decode(gemini, [geminiPart({ text: "hm", thought: true })])
    expect(types(events)).toEqual([
      "step-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "step-finish",
      "finish",
    ])
    expect(finishes(events).map((event) => event.reason)).toEqual(["error"])
  })

  test("a delivered functionCall whose stream ends with no finishReason closes as work to do", () => {
    // Nothing is DROPPED on this wire — a functionCall part is complete when it arrives — but before
    // the fix the turn never closed at all, so the calls sat in a step that never finished.
    const events = decode(gemini, [geminiPart({ functionCall: { name: "read", args: { path: "a.ts" } } })])
    expect(toolCalls(events).length).toBe(1)
    expect(finishes(events).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(events.filter(LLMEvent.is.finish).length).toBe(1)
  })

  test("a TEXT-only turn cut before its terminal event closes with its text block ended", () => {
    const events = decode(gemini, [geminiPart({ text: "partial ans" })])
    expect(finishes(events).map((event) => event.reason)).toEqual(["error"])
    expect(events.filter(LLMEvent.is.textEnd).length).toBe(1)
  })
})

describe("gemini — the SETTLED turn is untouched (negative control)", () => {
  test("the same stream WITH finishReason behaves exactly as before", () => {
    const cut = decode(gemini, [geminiPart({ functionCall: { name: "read", args: { path: "a.ts" } } })])
    const whole = decode(gemini, [geminiPart({ functionCall: { name: "read", args: { path: "a.ts" } } }), geminiEnd])
    expect(toolCalls(whole).length).toBe(1)
    expect(finishes(whole).map((event) => event.reason)).toEqual(["tool-calls"])
    expect(whole.filter(LLMEvent.is.finish).length).toBe(1)
    expect(types(whole)).toEqual(types(cut))
  })

  test("a plain text turn WITH finishReason=STOP still finishes as \"stop\"", () => {
    const events = decode(gemini, [geminiPart({ text: "hello" }), geminiEnd])
    expect(finishes(events).map((event) => event.reason)).toEqual(["stop"])
  })

  test("an accounting-only tail still closes, so `generate` can report the usage it received", () => {
    // This wire can end with a `usageMetadata` chunk carrying no candidate at all. It is the one
    // halt that closes a turn which produced no content, and it predates the cut-stream fix.
    const events = decode(gemini, [{ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }])
    expect(events.filter(LLMEvent.is.finish).length).toBe(1)
  })
})
