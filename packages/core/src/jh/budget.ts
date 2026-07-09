export * as JhBudget from "./budget"

// jh — retry budgets + observed difficulty (jh.md §6: the model's difficulty_prior seeds, the harness's
// runtime telemetry governs) and the §6d collapse-boundary staircase (a Levitt transformed up-down
// method converging on the p=0.5 verifier crossing) plus the D8 force-split trigger. Pure and
// deterministic — no clock, no telemetry side effects; the engine threads Telemetry in and reads a
// budget out each attempt.

import type { JhStep } from "./step"

export const RETRY_BUDGET = { trivial: 1, moderate: 2, hard: 3 } as const // attempts AFTER the first try

const RANK: Record<JhStep.DifficultyPrior, number> = { trivial: 0, moderate: 1, hard: 2 }

export interface Telemetry {
  readonly attempts: number
  readonly verifierFails: number
  readonly correctorCalls: number
  readonly parseFails: number
}
export const emptyTelemetry: Telemetry = { attempts: 0, verifierFails: 0, correctorCalls: 0, parseFails: 0 }

/** The harness's own difficulty read from runtime signals. */
export function observedDifficulty(t: Telemetry): JhStep.DifficultyPrior {
  if (t.verifierFails >= 2 || t.parseFails >= 2) return "hard"
  if (t.verifierFails === 1 || t.parseFails === 1) return "moderate"
  return "trivial"
}

/** The prior seeds, the observation governs: budget = RETRY_BUDGET[max(prior, observed)]
 *  (trivial < moderate < hard; a missing prior counts as moderate). */
export function budgetFor(prior: JhStep.DifficultyPrior | undefined, t: Telemetry): number {
  const observed = observedDifficulty(t)
  const seeded = prior ?? "moderate"
  const harder = RANK[seeded] >= RANK[observed] ? seeded : observed
  return RETRY_BUDGET[harder]
}

// §6d — Levitt simple up-down staircase, converges on the p=0.5 crossing.
export interface Staircase {
  readonly level: number
  readonly stepSize: number
  readonly lastPassed: boolean | undefined
  readonly reversals: ReadonlyArray<number>
}

export function staircaseInit(start: number, stepSize: number): Staircase {
  return { level: start, stepSize, lastPassed: undefined, reversals: [] }
}

/** pass → level + stepSize; fail → level − stepSize (floor 1). A direction flip records the level
 *  BEFORE this update as a reversal point. */
export function staircaseUpdate(s: Staircase, passed: boolean): Staircase {
  const flip = s.lastPassed !== undefined && s.lastPassed !== passed
  const reversals = flip ? [...s.reversals, s.level] : s.reversals
  const level = passed ? s.level + s.stepSize : Math.max(1, s.level - s.stepSize)
  return { level, stepSize: s.stepSize, lastPassed: passed, reversals }
}

/** Mean of the last K=6 reversal levels; undefined until 2 reversals exist. */
export function staircaseEstimate(s: Staircase): number | undefined {
  if (s.reversals.length < 2) return undefined
  const last = s.reversals.slice(-6)
  return last.reduce((a, b) => a + b, 0) / last.length
}

export interface SplitTrigger {
  readonly cardinality: number
  readonly density: number
  readonly margin: number
}
export const DEFAULT_TRIGGER: SplitTrigger = { cardinality: 8, density: 12, margin: 1 } // generous; Phase 13 calibrates

/** Force a split when measured cardinality (or density) exceeds its trigger minus the margin. */
export function shouldForceSplit(trigger: SplitTrigger, measured: { cardinality: number; density: number }): boolean {
  return measured.cardinality > trigger.cardinality - trigger.margin || measured.density > trigger.density - trigger.margin
}
