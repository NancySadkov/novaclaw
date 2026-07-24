// Thinking-budget controller (MindControl). Pins the event stitching: the multi-phase
// stop-and-continue is collapsed into ONE reasoning block + ONE text block, nudges are injected at
// the checkpoints (reached by reasoning-token count, not max_tokens), phase 1 runs prefill-free,
// and the common "model finishes on its own" path fires no continuation.
import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Message, Model, type LLMRequest } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"
import { ReasoningBudget } from "@novaclaw/core/session/runner/reasoning-budget"

const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
const base = LLM.request({ model, messages: [Message.user("solve it")] })

// ~4 chars/token; sizes below are chosen so cumulative reasoning crosses the phase checkpoints.
const rDelta = (chars: number) => LLMEvent.reasoningDelta({ id: "reasoning-0", text: "r".repeat(chars) })
const tDelta = (text: string) => LLMEvent.textDelta({ id: "text-0", text })
const finish = (reason: "stop" | "length") => LLMEvent.stepFinish({ index: 0, reason })

/** Canned per-phase event streams; records the request (prefill) each phase received. */
const faker = (phases: LLMEvent[][]) => {
  const requests: LLMRequest[] = []
  let call = 0
  const stream = (request: LLMRequest): Stream.Stream<LLMEvent, never, never> => {
    requests.push(request)
    const events = phases[call] ?? []
    call += 1
    return Stream.fromIterable(events)
  }
  return { stream, requests }
}

const run = (phases: LLMEvent[][], opts?: { budget?: number; answerMaxTokens?: number }) => {
  const fake = faker(phases)
  const events: LLMEvent[] = []
  Effect.runSync(
    Stream.runForEach(
      ReasoningBudget.stream({
        request: base,
        stream: fake.stream,
        budget: opts?.budget ?? 1000,
        answerMaxTokens: opts?.answerMaxTokens ?? 2048,
      }),
      (event) => Effect.sync(() => void events.push(event)),
    ),
  )
  return { events, requests: fake.requests }
}

const types = (events: LLMEvent[]) => events.map((e) => e.type)
const prefillOf = (request: LLMRequest) => {
  const last = request.messages[request.messages.length - 1]
  if (last?.role !== "assistant") return "" // phase 1 has no assistant prefill
  const part = last.content?.[0]
  return part && "text" in part ? (part.text as string) : ""
}

describe("ReasoningBudget", () => {
  test("natural close — reasoning under budget, no injected nudges", () => {
    // 40 chars ≈ 10 tokens, well under the 700-token opening checkpoint (budget 1000).
    const { events, requests } = run([[rDelta(40), tDelta("The ball costs $0.05."), finish("stop")]])
    expect(types(events)).toEqual([
      "reasoning-start",
      "reasoning-delta", // model reasoning
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
    ])
    expect(requests).toHaveLength(1)
    expect(prefillOf(requests[0]!)).toBe("") // no forced <think>
    expect(JSON.stringify(requests[0]!.system)).toContain("reasoning budget")
    expect((events[4] as { text: string }).text).toBe("The ball costs $0.05.")
  })

  test("full budget path — reasoning crosses opening then mid checkpoints, forced close", () => {
    // budget 100 → opening checkpoint 70 tokens (280 chars), mid checkpoint 100 tokens (400 chars).
    const { events, requests } = run(
      [
        [rDelta(300)], // ≈75 tokens > 70 → checkpoint → mid nudge
        [rDelta(120)], // cumulative crosses 100 → checkpoint → end nudge + forced close
        [tDelta("Final: $0.05."), finish("stop")], // end phase answers
      ],
      { budget: 100, answerMaxTokens: 2048 },
    )
    expect(types(events)).toEqual([
      "reasoning-start",
      "reasoning-delta", // opening reasoning (kept — not dropped by the checkpoint takeUntil)
      "reasoning-delta", // mid nudge
      "reasoning-delta", // mid reasoning
      "reasoning-delta", // end nudge
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
    ])
    expect(requests).toHaveLength(3)
    // phase 1 = normal request; mid keeps the think OPEN; end injects a real close.
    expect(prefillOf(requests[0]!)).toBe("")
    expect(prefillOf(requests[1]!)).toStartWith("<think>\n")
    expect(prefillOf(requests[1]!)).not.toContain("</think>")
    expect(prefillOf(requests[2]!)).toContain("</think>")
    // each continuation carries the accumulated reasoning forward.
    expect(prefillOf(requests[1]!)).toContain("r".repeat(300))
    // budget rides the mid-stream checkpoint, NOT max_tokens — every phase gets the full allowance.
    expect(requests[0]!.generation?.maxTokens).toBe(2048)
    expect(requests[1]!.generation?.maxTokens).toBe(2048)
    // continuation flags only on the prefilled phases.
    expect(requests[0]!.http?.body?.continue_final_message).toBeUndefined()
    expect(requests[1]!.http?.body?.continue_final_message).toBe(true)
    expect(requests[1]!.http?.body?.add_generation_prompt).toBe(false)
  })

  test("closes think but does not answer — forces one answer phase", () => {
    const { events, requests } = run([
      [rDelta(40), finish("stop")], // reasons under budget then stops, no answer
      [tDelta("answer after forced close"), finish("stop")], // forced end phase
    ])
    expect(types(events)).toEqual([
      "reasoning-start",
      "reasoning-delta", // reasoning
      "reasoning-delta", // end nudge
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "step-finish",
    ])
    expect(requests).toHaveLength(2)
    expect(prefillOf(requests[1]!)).toContain("</think>")
  })

  test("tool call ends reasoning and is forwarded", () => {
    const toolCall = LLMEvent.toolCall({ id: "call-1", name: "bash", input: { command: "ls" } })
    const { events } = run([[rDelta(40), toolCall, finish("stop")]])
    expect(types(events)).toEqual([
      "reasoning-start",
      "reasoning-delta", // reasoning
      "reasoning-end",
      "tool-call",
      "step-finish",
    ])
  })
})
