export * as JhProbe from "./probe"

// jh — the collapse-boundary calibration probe (jh.md §6d). A synthetic leaf at controlled closure
// cardinality K: K note artifacts each holding a seeded (LCG, never Math.random) 4-digit number; the
// step must read all K and produce their sum, checked by output_equals. Feeding pass/fail into a Levitt
// up-down staircase (JhBudget) converges on the p=0.5 crossing — the estimate of c*. Pure; the smoke
// supplies a real-engine `run`.

import { Effect } from "effect"
import { Hash } from "../util/hash"
import { JhBudget } from "./budget"
import type { JhArtifact } from "./artifact"

export interface BatteryTask {
  readonly k: number
  readonly artifacts: ReadonlyArray<JhArtifact.Stored>
  readonly stepGoal: string
  readonly expected: string
}

/** Deterministic K-artifact sum task. Each `art-i` holds a 4-digit number from a seeded LCG; `expected`
 *  is their sum. Closure cardinality is EXACTLY K (the step consumes all K). */
export function batteryTask(k: number, seed: number): BatteryTask {
  let state = seed >>> 0
  const lcg = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state
  }
  const artifacts: JhArtifact.Stored[] = []
  let sum = 0
  for (let i = 1; i <= k; i++) {
    const n = 1000 + (lcg() % 9000) // 4-digit
    sum += n
    const content = String(n)
    artifacts.push({ id: `art-${i}`, type: "note", hash: Hash.sha256(content), content })
  }
  // The values are inlined into the goal: the engine builds a step's context from its declared-consumes
  // closure, and the ROOT placeholder declares none, so seeded artifacts never reach the introspection.
  // Delivering the K numbers in the goal keeps the collapse variable — state cardinality K — intact.
  const values = artifacts.map((a) => a.content).join(", ")
  const stepGoal = `Compute the sum of these ${k} integers and output ONLY the resulting integer (no words, no commas, no explanation): ${values}.`
  return { k, artifacts, stepGoal, expected: String(sum) }
}

export interface StaircaseResult {
  readonly trace: ReadonlyArray<{ readonly k: number; readonly passed: boolean }>
  readonly estimate: number | undefined
}

/** Drive an up-down staircase over `run`: probe at the current (rounded, ≥1) level, feed pass/fail
 *  back, halve the step to 1 after the first reversal, stop after `maxProbes` or 6 reversals. */
export function staircaseDriver(input: {
  readonly run: (task: BatteryTask) => Effect.Effect<boolean>
  readonly seed: number
  readonly start: number
  readonly stepSize: number
  readonly maxProbes: number
}): Effect.Effect<StaircaseResult> {
  return Effect.gen(function* () {
    let staircase = JhBudget.staircaseInit(input.start, input.stepSize)
    const trace: { k: number; passed: boolean }[] = []
    for (let probe = 0; probe < input.maxProbes; probe++) {
      const k = Math.max(1, Math.round(staircase.level))
      const passed = yield* input.run(batteryTask(k, input.seed + probe))
      trace.push({ k, passed })
      staircase = JhBudget.staircaseUpdate(staircase, passed)
      // Step-halving: after the first reversal, refine to unit steps.
      if (staircase.reversals.length >= 1 && staircase.stepSize > 1) {
        staircase = { ...staircase, stepSize: 1 }
      }
      if (staircase.reversals.length >= 6) break
    }
    return { trace, estimate: JhBudget.staircaseEstimate(staircase) }
  })
}
