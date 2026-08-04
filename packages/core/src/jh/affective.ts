export * as JhAffective from "./affective"

import { Affective } from "../affective"
import type { JhLog } from "./log"

// improve18 (owner directive): AFFECTIVE × STRICT — one engine, two callers.
//
// Imports `../affective` (the core-root homeostat, zero deps) — NOT the session tree: the §0.7.2
// import guard keeps jh off session/tool/config/v1/llm/schema, and it is right to. The homeostat
// was moved to the core root precisely so both engines can share it without that violation.
//
// The two modes are orthogonal and should strengthen each other: Strict owns the STRUCTURE (what to
// do next, verified), affective owns the DISPOSITION (how to sample while doing it). Until now they
// had never met — `session/runner/affective.ts` hooks only the normal drain loop, `strict.ts` routes
// through JhEngine, and the jh rigs pinned temperature flat. This module is the missing adapter: it
// drives the SAME homeostat (`appraiseObserved` + `toSampling`) from jh's own step cycle, so nothing
// is re-implemented and the session engine stays the single source of truth.
//
// ⚠️ The design fact that matters (affective.ts's own contract): `toolsPresent` clamps temperature to
// ≤0.6 because high temperature corrupts tool-call JSON. In jh EVERY call is a JSON step-fill, so
// `toolsPresent` is ALWAYS true and affective's contribution here is deliberately NOT heat — it is:
//   · frequencyPenalty / presencePenalty  (bumped by boredom+frustration) — anti-REPETITION, which is
//     precisely the refrain/self-copy defect that dominated waves 15-17 and that jh has never had a
//     sampling-side answer for;
//   · topP / topK modulation around the configured baseline;
//   · a satisfaction-driven calm-down once progress resumes.
// Wave-17 measured parse at 3.7% even at temp 1.0, so the clamp may be over-conservative for this
// model — but that is an A/B question, not an assumption to bake in.

/** What jh knows after one step — the jh-shaped appraisal facts. */
export interface Step {
  /** The tool + args the model chose (jh's `action` log), e.g. `write_file({"path":"ch1.md",…})`. */
  readonly action?: string
  /** What came back — the observation output, or the verification detail when the check failed. */
  readonly result?: string
  /** Whether the step actually ran a tool (jh atoms always do; a decomposition does not). */
  readonly acted: boolean
}

export interface State {
  readonly mood: Affective.Mood
}

export const initial: State = { mood: Affective.calmMood }

/** One homeostatic step from jh's own cycle — the same appraisal the session drain loop runs. */
export const step = (state: State, input: Step): State => ({
  mood: Affective.appraiseObserved(state.mood, {
    ...(input.action !== undefined ? { action: input.action } : {}),
    ...(input.result !== undefined ? { toolResult: input.result } : {}),
    acted: input.acted,
  }),
})

/**
 * Fold jh log entries into the appraisal facts. The engine emits `action` (tool chosen),
 * `observation` (it ran), and `verification` (ok + detail) per step; a verification FAILURE is the
 * result that matters (it carries the error text the homeostat appraises), and an `expanded` /
 * `committed` entry is progress.
 */
export const fromLog = (state: State, entry: JhLog.Entry, pending: { action?: string }): State => {
  switch (entry.type) {
    case "action":
      pending.action = `${entry.tool}(${entry.step})`
      return state
    case "verification": {
      const next = step(state, {
        ...(pending.action !== undefined ? { action: pending.action } : {}),
        // A passing check is a genuinely new result (progress); a failing one carries the error.
        result: entry.ok ? `ok:${entry.step}:${Date.now()}` : entry.detail,
        acted: true,
      })
      pending.action = undefined
      return next
    }
    case "committed":
    case "expanded":
    case "scored":
      // Progress: let the homeostat relax the way a new tool result does.
      return step(state, { result: `progress:${entry.type}:${Math.random()}`, acted: true })
    default:
      return state
  }
}

/**
 * The sampling override for jh's next LLM call. `toolsPresent: true` is FAITHFUL, not conservative —
 * every jh call asks for a JSON step — so this returns anti-repetition pressure + a modest topP/topK
 * band around the rig's configured baseline, never a temperature blowout.
 */
export const sampling = (state: State, base: Affective.SamplingBase): Affective.SamplingOverride =>
  Affective.toSampling(state.mood, base, { toolsPresent: true, extended: true })

/** The one-shot loop-breaker steer, when the mood says the model is stuck repeating itself. */
export const intervention = (state: State): string | undefined => Affective.intervention(state.mood)
