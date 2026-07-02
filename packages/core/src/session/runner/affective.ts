// P3 — the affective engine, ported native from afpro.py (notes/afpro.py is the reference;
// the proxy stays available via a baseURL route, this is the durable form). Emotions are
// cheap homeostatic controllers: scalars in [0,1] that DECAY toward calm each step and are
// BUMPED by appraised events (errors, repetition, progress, time-on-task). The blended mood
// modulates sampling AROUND the model's configured baseline — never blowing it out (high
// temperature corrupts tool-call JSON) — and high frustration/urgency additionally inject a
// one-shot redirect, because sampling alone cannot break a repeat-the-same-action loop.
//
// Pure + dependency-light: mood transitions and the sampling map are unit-tested without a
// model. The runner owns the per-session mood store and the steer injection.

import type { SessionMessage } from "../message"

export interface Mood {
  readonly frustration: number
  readonly satisfaction: number
  readonly boredom: number
  readonly urgency: number
  readonly lastToolResult: string
  readonly lastAssistant: string
  readonly lastAction: string
}

export const calmMood: Mood = {
  frustration: 0,
  satisfaction: 0,
  boredom: 0,
  urgency: 0,
  lastToolResult: "",
  lastAssistant: "",
  lastAction: "",
}

// Dynamics (afpro's tuned constants).
const DECAY = 0.55
const CURIOSITY_FLOOR = 0.12
const TEMP_UP = 0.45
const TEMP_DOWN = 0.25
const TEMP_FLOOR = 0.2
const TEMP_CEIL = 1.15
const TOOL_TEMP_CEIL = 0.6
const TOPP_UP = 0.1
const TOPP_DOWN = 0.05
const FREQ_MAX = 0.5
const PRES_MAX = 0.5
export const FRUST_INTERVENE = 0.7
export const URGENCY_INTERVENE = 0.8

const ERROR_RE =
  /\b(error|traceback|exception|failed|failure|denied|not found|cannot|undefined|segmentation|fatal|exit code [1-9])\b/i

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const clamp01 = (x: number) => clamp(x, 0, 1)
// A cheap stable fingerprint (FNV-1a) — only used for same-as-last comparisons.
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

interface Observed {
  readonly toolResult?: string
  readonly action?: string
  readonly assistantText?: string
  readonly acted: boolean
}

/** The appraisal inputs from the projected V2 context: the LAST tool result, tool action, and assistant text. */
export function observe(context: ReadonlyArray<SessionMessage.Message>): Observed {
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
 * One homeostatic step: decay toward calm, then bump from what just happened. Mirrors
 * afpro's `appraise` + `register_response` folded into one pass over the current context
 * (the V2 runner sees the full projected history between steps).
 */
export function appraise(mood: Mood, context: ReadonlyArray<SessionMessage.Message>): Mood {
  const seen = observe(context)
  let frustration = mood.frustration * DECAY
  let satisfaction = mood.satisfaction * DECAY
  let boredom = mood.boredom * DECAY
  let urgency = mood.urgency
  let lastToolResult = mood.lastToolResult
  let lastAssistant = mood.lastAssistant
  let lastAction = mood.lastAction

  if (seen.toolResult !== undefined) {
    const hash = fingerprint(seen.toolResult)
    if (ERROR_RE.test(seen.toolResult)) frustration = clamp01(frustration + 0.4) // something broke
    if (hash === lastToolResult) {
      frustration = clamp01(frustration + 0.3) // SAME result as before = no progress
      boredom = clamp01(boredom + 0.3)
    } else if (lastToolResult) {
      satisfaction = clamp01(satisfaction + 0.4) // a genuinely new result = progress/relief
      frustration *= 0.5
      urgency = 0 // progress resets the clock
    }
    lastToolResult = hash
  }

  if (seen.action !== undefined) {
    const hash = fingerprint(seen.action)
    if (hash === lastAction) {
      frustration = clamp01(frustration + 0.3) // repeating the exact same (tool, args)
      boredom = clamp01(boredom + 0.2)
    }
    lastAction = hash
  }

  if (seen.acted) {
    urgency = clamp01(urgency - 0.2) // it acted -> ease the clock a little
  } else if (seen.assistantText !== undefined) {
    urgency = clamp01(urgency + 0.1) // only talked -> pressure builds
    const hash = fingerprint(seen.assistantText)
    if (hash === lastAssistant) {
      boredom = clamp01(boredom + 0.4) // verbatim repetition (type-2 loop)
      frustration = clamp01(frustration + 0.2)
    }
    lastAssistant = hash
  }

  // time-on-task: every step without a progress reset nudges urgency up
  urgency = clamp01(urgency + 0.15)

  return { frustration, satisfaction, boredom, urgency, lastToolResult, lastAssistant, lastAction }
}

export interface SamplingBase {
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
}

export interface SamplingOverride {
  temperature: number
  topP: number
  topK?: number
  frequencyPenalty: number
  presencePenalty: number
}

/**
 * Map the mood onto sampling params, modulated AROUND the configured baseline. `toolsPresent`
 * clamps temperature/top_p toward focus regardless of mood — a tool call is likely this turn
 * and valid JSON beats exploration. `extended` additionally modulates top_k (native-path
 * capable since 1C).
 */
export function toSampling(
  mood: Mood,
  base: SamplingBase,
  options: { readonly toolsPresent: boolean; readonly extended: boolean },
): SamplingOverride {
  const explore = clamp01(0.6 * mood.frustration + 0.4 * mood.boredom + CURIOSITY_FLOOR)
  const calm = mood.satisfaction

  const baseTemp = base.temperature ?? 0.7
  let temperature = baseTemp + TEMP_UP * explore - TEMP_DOWN * calm
  temperature -= 0.15 * mood.urgency // urgency favours decisiveness, not thrashing
  temperature = clamp(temperature, TEMP_FLOOR, TEMP_CEIL)

  const basePp = base.topP ?? 0.95
  let topP = clamp(basePp + TOPP_UP * explore - TOPP_DOWN * calm, 0.5, 1)

  const out: SamplingOverride = {
    temperature: round3(temperature),
    topP: round3(topP),
    frequencyPenalty: round3(clamp((base.frequencyPenalty ?? 0) + 0.3 * mood.boredom + 0.15 * mood.frustration, 0, FREQ_MAX)),
    presencePenalty: round3(clamp((base.presencePenalty ?? 0) + 0.2 * mood.boredom, 0, PRES_MAX)),
  }
  if (options.extended) out.topK = Math.round(clamp((base.topK ?? 40) + 60 * explore - 20 * calm, 10, 120))

  if (options.toolsPresent) {
    out.temperature = round3(Math.min(out.temperature, TOOL_TEMP_CEIL))
    out.topP = round3(Math.min(out.topP, 0.9))
  }
  return out
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/** Emotion expressed as a one-shot behavioural nudge — the real loop-breaker. */
export function intervention(mood: Mood): string | undefined {
  if (mood.frustration >= FRUST_INTERVENE)
    return (
      "Your last action did not change the result. Stop repeating it. Re-read the error/output " +
      "carefully and try a genuinely different approach — a different tool, a different command, " +
      "or rethink the plan from the actual error."
    )
  if (mood.urgency >= URGENCY_INTERVENE)
    return (
      "You have spent several steps without making progress. Stop deliberating and take ONE " +
      "concrete action now — call a tool or commit to a definite next step."
    )
  return undefined
}

export * as Affective from "./affective"
