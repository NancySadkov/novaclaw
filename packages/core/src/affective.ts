export * as Affective from "./affective"

// The affective homeostat — PURE. Emotions as cheap homeostatic controllers: scalars in [0,1] that
// DECAY toward calm each step and are BUMPED by appraised events (errors, repetition, progress,
// time-on-task). The blended mood modulates sampling AROUND the configured baseline — never blowing
// it out (high temperature corrupts tool-call JSON) — and a high frustration/urgency additionally
// yields a one-shot redirect, because sampling alone cannot break a repeat-the-same-action loop.
// Ported native from afpro.py (notes/afpro.py is the reference).
//
// improve18: this lives at the CORE ROOT, with ZERO dependencies, because BOTH engines drive it —
// the normal session drain loop (via `session/runner/affective`'s `observe()` adapter) and the jh
// Strict engine (via `jh/affective`). It used to sit under session/runner/, which put it off-limits
// to jh by the §0.7.2 import guard (jh may not reach into the session tree — rightly). The homeostat
// is not a session concept: it is arithmetic over "what did I just do and what came back".

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
// improve18: these are HEADROOM above the configured baseline, not absolute caps. They used to be
// absolute — which silently INVERTED the lever on any model whose recommended baseline already sits
// high: our Qwen3.6-35B-A3B server runs `--override-generation-config {…"presence_penalty":1.1…}`
// (the MoE build's documented anti-repetition default; the model card asks 1.1-1.5), so
// `clamp(1.1 + boredom, 0, 0.5)` returned 0.5 — affective "modulating" a 1.1 penalty DOWN to 0.5,
// and an unset base made the request send 0-0.5 where the server would otherwise have applied 1.1.
// Either way the mood engine STRIPPED the model's repetition protection — on the exact defect
// (verbatim self-copy) it is meant to fight. Penalties now only ever RISE from the baseline.
// (For a base of 0 — every other model/config today — the behavior is byte-identical.)
const FREQ_MAX = 0.5
const PRES_MAX = 0.5
/** Qwen documents presence/frequency penalties on a 0-2 scale; never exceed it. */
const PENALTY_CEIL = 2
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

/**
 * The appraisal inputs. EXPORTED (improve18) so non-session callers can drive the same homeostat:
 * the jh Strict engine has no `SessionMessage` history, but it produces exactly these facts every
 * step (the action it took, the observation it got back, whether it acted) — so Strict and the
 * normal drain loop now share ONE affective engine instead of two look-alikes.
 */
export interface Observed {
  readonly toolResult?: string
  readonly action?: string
  readonly assistantText?: string
  readonly acted: boolean
}

/** The appraisal inputs from the projected V2 context: the LAST tool result, tool action, and assistant text. */
/**
 * One homeostatic step: decay toward calm, then bump from what just happened. Mirrors
 * afpro's `appraise` + `register_response` folded into one pass. improve18: this is the PURE
 * core — it takes the appraisal facts directly, so any caller that can say "here is the action I
 * took and the result I got" drives the same homeostat (the session runner via `observe()`, the
 * jh Strict engine via `JhAffective`).
 */
export function appraiseObserved(mood: Mood, seen: Observed): Mood {
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
  /**
   * improve18: the tool-turn temperature ceiling is a MODEL PROPERTY, not a universal law.
   * `TOOL_TEMP_CEIL` (0.6) encodes the general heuristic "high temperature corrupts tool-call
   * JSON" — measured FALSE for our Qwen3.6-35B-A3B build: step-JSON validity was 6/6 at every
   * temperature from 0.3 to 1.3, while creative diversity only appears at ≥1.0 (the model's OWN
   * default; pairwise 5-gram overlap 0.021 @0.6 → 0.000 @1.0). On such a model the clamp pins the
   * harness into the flat zone — the opposite of what affective is for. Unset = 0.6 (every
   * existing deployment is unchanged).
   */
  readonly toolTempCeil?: number
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
    // Penalties RISE from the configured baseline (never below it — see the FREQ_MAX/PRES_MAX note):
    // floor = the model's own recommended value, ceiling = that + our headroom, hard-capped at 2.
    frequencyPenalty: round3(
      clamp(
        (base.frequencyPenalty ?? 0) + 0.3 * mood.boredom + 0.15 * mood.frustration,
        base.frequencyPenalty ?? 0,
        Math.min(PENALTY_CEIL, (base.frequencyPenalty ?? 0) + FREQ_MAX),
      ),
    ),
    presencePenalty: round3(
      clamp(
        (base.presencePenalty ?? 0) + 0.2 * mood.boredom,
        base.presencePenalty ?? 0,
        Math.min(PENALTY_CEIL, (base.presencePenalty ?? 0) + PRES_MAX),
      ),
    ),
  }
  if (options.extended) out.topK = Math.round(clamp((base.topK ?? 40) + 60 * explore - 20 * calm, 10, 120))

  if (options.toolsPresent) {
    out.temperature = round3(Math.min(out.temperature, base.toolTempCeil ?? TOOL_TEMP_CEIL))
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
