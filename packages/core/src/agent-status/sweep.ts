export * as AgentStatusSweep from "./sweep"

import { Effect } from "effect"
import { AgentStatus } from "../agent-status"
import { REFRESH_INTERVAL_MS } from "./refresh"
import { runPass, type PassDeps } from "./pass"

/**
 * The status sweep, as the scheduler tick calls it.
 *
 * ⚠️ It rides the CALENDAR tick rather than owning a timer, for the reason that tick's own comment
 * gives about its other rider: *"a sweeper kept alive for one notice is a subsystem, and two
 * schedulers drift."* This one is a third question asked on the same heartbeat, not a fourth loop.
 *
 * ⚠️ Two intervals, and they answer different questions. `REFRESH_INTERVAL_MS` is how often a
 * colleague's LINE may be rewritten — durable, per colleague, and the thing the user experiences.
 * `LOOK_INTERVAL_MS` is how often this process bothers to ASK whether anything is due — in memory,
 * instance-wide, and purely a cost control. Without the second, a 30-second tick would run the
 * activity query 360 times per useful refresh; without the first, looking often would mean
 * summarising often.
 */

/** How often to run the activity query at all. Derived, so the two cannot drift into disagreement. */
export const LOOK_INTERVAL_MS = REFRESH_INTERVAL_MS / 12

export type SweepState = {
  /** When this process last ran the activity query. `undefined` until the first sweep. */
  lastLooked: number | undefined
}

export const makeState = (): SweepState => ({ lastLooked: undefined })

/**
 * Look, if it is time to look.
 *
 * ⚠️ The FIRST call always looks. A process that started because the previous one died should not
 * wait a quarter of an interval before noticing that every colleague's line is stale — and on a
 * fresh instance the first colleague to do anything gets its line immediately, which is the
 * behaviour `refresh.ts` goes out of its way to allow.
 */
export const sweep = (state: SweepState, deps: Omit<PassDeps, "now">, now: number) =>
  Effect.gen(function* () {
    if (state.lastLooked !== undefined && now - state.lastLooked < LOOK_INTERVAL_MS) return undefined
    state.lastLooked = now
    return yield* runPass({ ...deps, now: () => now })
  })

/** The deps a real instance supplies, minus the model half the caller injects. */
export const storeDeps = Effect.fn("AgentStatus.storeDeps")(function* () {
  const status = yield* AgentStatus.Service
  return {
    candidates: () => status.candidates(),
    write: (info: { agent: string; task: string; observed: number }) => status.set(info),
  }
})
