import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, type LLMRequest } from "../schema"
import { Gemini } from "./gemini"
import { OpenAIChat } from "./openai-chat"

// A model that thinks, speaks, and thinks again in one response — or a backend that emits a stray
// newline in `content` between two thinking segments. The two wires that carry no reasoning id of
// their own have to synthesize one, and a CONSTANT is the wrong synthesis: the second open re-uses
// an id the consumer has already seen ended, so whichever store keys on it keeps one of the two
// thought blocks and silently loses the other.
const request = { tools: [] } as unknown as LLMRequest

interface Streamable {
  readonly initial: (request: never) => unknown
  readonly step: (state: never, event: never) => Effect.Effect<readonly [unknown, ReadonlyArray<LLMEvent>], unknown>
  readonly onHalt?: (state: never) => ReadonlyArray<LLMEvent>
}

function decode(stream: Streamable, events: ReadonlyArray<Record<string, unknown>>): LLMEvent[] {
  let state = stream.initial(request as never)
  const emitted: LLMEvent[] = []
  for (const event of events) {
    const [next, produced] = Effect.runSync(stream.step(state as never, event as never))
    state = next
    emitted.push(...produced)
  }
  emitted.push(...(stream.onHalt?.(state as never) ?? []))
  return emitted
}

const openaiChat = OpenAIChat.protocol.stream as unknown as Streamable
const gemini = Gemini.protocol.stream as unknown as Streamable

const chatReasoning = (text: string) => ({ choices: [{ delta: { reasoning_content: text }, finish_reason: null }] })
const chatText = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] })
const chatStop = { choices: [{ delta: {}, finish_reason: "stop" }] }

const geminiPart = (part: Record<string, unknown>) => ({
  candidates: [{ content: { role: "model", parts: [part] } }],
})
const geminiStop = { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] }

/** Every id that was opened, in order; and every id that was ended, in order. */
const opened = (events: ReadonlyArray<LLMEvent>) => events.filter(LLMEvent.is.reasoningStart).map((event) => event.id)
const ended = (events: ReadonlyArray<LLMEvent>) => events.filter(LLMEvent.is.reasoningEnd).map((event) => event.id)

describe("a re-opened reasoning block never re-uses an id that already ended", () => {
  test("openai-chat: think, speak, think again gives TWO distinct reasoning ids", () => {
    const events = decode(openaiChat, [
      chatReasoning("first thought"),
      chatText("an aside"),
      chatReasoning("second thought"),
      chatStop,
    ])
    expect(opened(events)).toEqual(["reasoning-0", "reasoning-1"])
    // and each id ends exactly once — the defect's signature was a second `Ended` for "reasoning-0"
    expect(ended(events)).toEqual(["reasoning-0", "reasoning-1"])
    expect(new Set(ended(events)).size).toBe(ended(events).length)
  })

  test("gemini: think, answer, think again gives TWO distinct reasoning ids", () => {
    const events = decode(gemini, [
      geminiPart({ text: "first thought", thought: true }),
      geminiPart({ text: "an aside" }),
      geminiPart({ text: "second thought", thought: true }),
      geminiStop,
    ])
    expect(opened(events)).toEqual(["reasoning-0", "reasoning-1"])
    expect(ended(events)).toEqual(["reasoning-0", "reasoning-1"])
    expect(new Set(ended(events)).size).toBe(ended(events).length)
  })

  test("openai-chat: a tool call after a thought closes the segment and the NEXT thought opens a new id", () => {
    const events = decode(openaiChat, [
      chatReasoning("first thought"),
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{}" } }] } }],
      },
      chatReasoning("second thought"),
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])
    expect(opened(events)).toEqual(["reasoning-0", "reasoning-1"])
    expect(new Set(ended(events)).size).toBe(ended(events).length)
  })
})

describe("the ORDINARY turn keeps its id (negative control for the segment counter)", () => {
  test("openai-chat: one thought then an answer stays on reasoning-0", () => {
    const events = decode(openaiChat, [chatReasoning("thinking"), chatText("answer"), chatStop])
    expect(opened(events)).toEqual(["reasoning-0"])
    expect(ended(events)).toEqual(["reasoning-0"])
  })

  test("gemini: one thought then an answer stays on reasoning-0", () => {
    const events = decode(gemini, [
      geminiPart({ text: "thinking", thought: true }),
      geminiPart({ text: "answer" }),
      geminiStop,
    ])
    expect(opened(events)).toEqual(["reasoning-0"])
    expect(ended(events)).toEqual(["reasoning-0"])
  })

  test("openai-chat: a turn with NO reasoning never burns a segment id", () => {
    // The advance is conditional on the block having been open; an unconditional bump would move the
    // id on every text delta and make the first thought of a later turn open "reasoning-7".
    const events = decode(openaiChat, [chatText("a"), chatText("b"), chatReasoning("late thought"), chatStop])
    expect(opened(events)).toEqual(["reasoning-0"])
  })
})
