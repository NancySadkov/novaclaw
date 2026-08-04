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

/** A per-phase script: canned events, or "ERROR" to make that phase's provider stream fail. */
type PhaseScript = LLMEvent[] | "ERROR"

/** Canned per-phase event streams; records the request (prefill) each phase received. */
const faker = (phases: PhaseScript[]) => {
  const requests: LLMRequest[] = []
  let call = 0
  const stream = (request: LLMRequest): Stream.Stream<LLMEvent, Error, never> => {
    requests.push(request)
    const script = phases[call] ?? []
    call += 1
    return script === "ERROR" ? Stream.fail(new Error("provider 400")) : Stream.fromIterable(script)
  }
  return { stream, requests }
}

const run = (phases: PhaseScript[], opts?: { budget?: number }) => {
  const fake = faker(phases)
  const events: LLMEvent[] = []
  Effect.runSync(
    Stream.runForEach(
      ReasoningBudget.stream({
        request: base,
        stream: fake.stream,
        budget: opts?.budget ?? 1000,
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
      { budget: 100 },
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
    // phase 1 = normal request; mid AND end both keep the think OPEN (a closed `</think>` prefill is
    // stripped by qwen's chat template and 400s the continuation — see phaseRequest).
    expect(prefillOf(requests[0]!)).toBe("")
    expect(prefillOf(requests[1]!)).toStartWith("<think>\n")
    expect(prefillOf(requests[1]!)).not.toContain("</think>")
    expect(prefillOf(requests[2]!)).toStartWith("<think>\n")
    expect(prefillOf(requests[2]!)).not.toContain("</think>")
    // Each continuation carries the accumulated reasoning forward — but the crossing delta is CUT at
    // the ceiling (70 tokens = 280 chars), so the cap holds even if a provider batches its stream into
    // one huge chunk. Without the cut, 300 chars would ride through and the overshoot would compound.
    expect(prefillOf(requests[1]!)).toContain("r".repeat(280))
    expect(prefillOf(requests[1]!)).not.toContain("r".repeat(281))
    // budget rides the mid-stream checkpoint, NOT max_tokens — phases INHERIT the base request's own
    // limit (here unset) so `prompt + max_tokens` can never overflow the context window.
    expect(requests[0]!.generation?.maxTokens).toBeUndefined()
    expect(requests[1]!.generation?.maxTokens).toBeUndefined()
    // continuation flags only on the prefilled phases.
    expect(requests[0]!.http?.body?.continue_final_message).toBeUndefined()
    expect(requests[1]!.http?.body?.continue_final_message).toBe(true)
    expect(requests[1]!.http?.body?.add_generation_prompt).toBe(false)
  })

  test("RUNAWAY: a model that ignores both nudges is still cut off — no unbounded final phase", () => {
    // The pathology this feature exists for (owner report 2026-07-25): a degenerate digit loop that
    // reasons straight through both nudges. Every phase must have a FINITE ceiling, so the whole turn
    // terminates on a bounded multiple of the budget instead of streaming forever.
    const runaway = Array.from({ length: 40 }, () => rDelta(4000)) // 160k chars ≈ 40k tokens
    const { events } = run(
      [
        [rDelta(300)], // opening: >70 → mid nudge
        [rDelta(200)], // mid: crosses 100 → end nudge
        runaway, // end: ignores the nudge and keeps looping
        runaway, // any further phase must ALSO be bounded
        runaway,
      ],
      { budget: 100 },
    )
    const reasoned = events
      .filter((e): e is LLMEvent & { text: string } => e.type === "reasoning-delta")
      .reduce((sum, e) => sum + e.text.length, 0)
    // Hard bound: a 100-token budget must never emit tens of thousands of reasoning tokens.
    expect(reasoned / 4).toBeLessThan(100 * 4)
    // And the turn must still be well-formed + terminated.
    expect(types(events).at(-1)).toBe("step-finish")
    expect(types(events)).toContain("reasoning-end")
  })

  test("HARD STOP: after both nudges are ignored, thinking is DISABLED for the final phase", () => {
    // The escalation from informational to mechanical. A nudge is text the model may ignore; the flag
    // removes the capability — qwen's template cannot open a <think> block, so it must answer.
    const { requests } = run(
      [
        [rDelta(300)], // opening → mid nudge
        [rDelta(200)], // mid → end nudge
        [rDelta(400)], // end → ignored the nudge → HARD STOP
        [tDelta("391."), finish("stop")], // answers with thinking off
      ],
      { budget: 100 },
    )
    expect(requests).toHaveLength(4)
    const hard = requests[3]!
    expect((hard.http?.body as Record<string, unknown>)?.["chat_template_kwargs"]).toEqual({
      enable_thinking: false,
    })
    // A clean request — no assistant prefill: a closed-`</think>` continuation returns an EMPTY
    // completion on qwen (probed live 2026-07-25), so the runaway reasoning is NOT fed back.
    expect(prefillOf(hard)).toBe("")
    expect(hard.http?.body?.["continue_final_message"]).toBeUndefined()
    expect(JSON.stringify(hard.system)).toContain("Do NOT reason further")
    // The earlier phases must NOT carry the flag — thinking stays enabled while budget remains.
    expect((requests[0]!.http?.body as Record<string, unknown>)?.["chat_template_kwargs"]).toBeUndefined()
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
    expect(prefillOf(requests[1]!)).toStartWith("<think>\n")
    expect(prefillOf(requests[1]!)).not.toContain("</think>")
  })

  test("continuation failure degrades gracefully — no crash, reasoning closed", () => {
    // budget 100 → opening crosses at 70 tokens, fires a mid continuation whose provider stream FAILS
    // (e.g. an unsupported backend or a context-overflow 400). The turn must not crash: it closes the
    // reasoning it already has and finishes cleanly.
    const { events, requests } = run(
      [
        [rDelta(300)], // opening reasoning crosses the checkpoint → mid continuation
        "ERROR", // the continuation request fails
      ],
      { budget: 100 },
    )
    expect(types(events)).toEqual([
      "reasoning-start",
      "reasoning-delta", // opening reasoning
      "reasoning-delta", // mid nudge (emitted before the failed continuation)
      "reasoning-end",
      "step-finish",
    ])
    expect(requests).toHaveLength(2) // opening + the (failed) mid continuation
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
