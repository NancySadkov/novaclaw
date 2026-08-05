import { LLMEvent } from "@novaclaw/llm"
import { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"

/**
 * The three STREAMED FRAGMENT kinds, and the events that build each one.
 *
 * ⭐ **Why one fixture over three kinds rather than three separate claims.** Text, reasoning and tool
 * input are different content types with different projections, but they share a lifecycle — start,
 * deltas, end — and the claims worth making are about that lifecycle rather than about any one kind:
 * deltas must not be stored as rewrites, a partial fragment must be closed durably when the stream
 * fails, and the same when the turn is interrupted. Parameterising means a new fragment kind inherits
 * all three claims instead of quietly having none, which is the failure mode a hand-written trio has.
 *
 * ⚠️ **`tool input` is not symmetric with the other two and the asymmetry is real, not an oversight.**
 * Its complete form ends at `toolInputEnd` with no `stepFinish`/`finish` — a tool call is not the end of
 * a turn — and an interrupted tool fragment projects as `status: "error"` rather than keeping its
 * partial content, because a half-parsed tool input is not something a model may act on. Keep that
 * branch honest if a fourth kind is added.
 */
export type FragmentKind = "text" | "reasoning" | "tool input"

export const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

export const fragmentID = (kind: FragmentKind, suffix: string) =>
  `${kind === "tool input" ? "call" : kind}-${suffix}`

export interface FragmentFixture {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

export const fragmentFixture = (
  kind: FragmentKind,
  id: string,
  chunks: readonly string[],
): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((chunk) => LLMEvent.textDelta({ id, text: chunk })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((chunk) => LLMEvent.reasoningDelta({ id, text: chunk })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((chunk) => LLMEvent.toolInputDelta({ id, name: "echo", text: chunk })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}
