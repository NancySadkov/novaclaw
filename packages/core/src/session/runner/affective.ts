export * as Affective from "./affective"

// The SESSION adapter for the affective homeostat. The engine itself is `core/src/affective.ts`
// (pure, shared with jh Strict since improve18); this file owns the one genuinely session-shaped
// piece — projecting the V2 message history into the appraisal facts — and re-exports the rest so
// existing callers (`Affective.toSampling`, `Affective.calmMood`, …) are unchanged.

import type { SessionMessage } from "../message"
import { Affective as Core } from "../../affective"

export type { Mood, Observed, SamplingBase, SamplingOverride } from "../../affective"
export const calmMood = Core.calmMood
export const appraiseObserved = Core.appraiseObserved
export const toSampling = Core.toSampling
export const intervention = Core.intervention
export const FRUST_INTERVENE = Core.FRUST_INTERVENE
export const URGENCY_INTERVENE = Core.URGENCY_INTERVENE

export function observe(context: ReadonlyArray<SessionMessage.Message>): Core.Observed {
  let toolResult: string | undefined
  let action: string | undefined
  let assistantText: string | undefined
  let acted = false
  for (const message of context) {
    if (message.type !== "assistant") continue
    let sawTool = false
    for (const part of message.content) {
      if (part.type === "tool") {
        sawTool = true
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        action = `${part.name}(${input})`
        if ("output" in part.state && typeof part.state.output === "string") toolResult = part.state.output
      }
      if (part.type === "text" && part.text.trim()) assistantText = part.text
    }
    acted = sawTool
  }
  return { toolResult, action, assistantText, acted }
}

/**
 * One homeostatic step over the SESSION context: project it to `Observed`, then appraise.
 * (The V2 runner sees the full projected history between steps.)
 */
export function appraise(mood: Core.Mood, context: ReadonlyArray<SessionMessage.Message>): Core.Mood {
  return Core.appraiseObserved(mood, observe(context))
}
