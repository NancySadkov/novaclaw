import { Effect } from "effect"
import { due, type Candidate } from "./refresh"

/**
 * One sweep: for every colleague whose line is due, derive a fresh one.
 *
 * Dependencies are injected rather than resolved here, so the ORCHESTRATION — which colleagues are
 * skipped, what is written, and what a failure costs — can be exercised without a database or a
 * model. Those are the decisions; the model call is not.
 */

export type PassDeps = {
  readonly candidates: () => Effect.Effect<readonly Candidate[]>
  /** The colleague's recent conversation as text, or `undefined` when it has nothing to summarise. */
  readonly recent: (agent: string) => Effect.Effect<string | undefined>
  /** The model call plus cleaning. `undefined` means "nothing usable came back". */
  readonly label: (agent: string, text: string) => Effect.Effect<string | undefined>
  readonly write: (info: { agent: string; task: string; observed: number }) => Effect.Effect<void>
  readonly now: () => number
}

export type PassResult = {
  /** Colleagues whose line was rewritten. */
  readonly refreshed: number
  /** Due colleagues that produced nothing usable, so their previous line stands. */
  readonly skipped: number
  /** Colleagues whose derivation FAILED. The pass continued; the line is unchanged. */
  readonly failed: number
}

export const runPass = (deps: PassDeps): Effect.Effect<PassResult> =>
  Effect.gen(function* () {
    const now = deps.now()
    const candidates = due(yield* deps.candidates(), now)
    let refreshed = 0
    let skipped = 0
    let failed = 0

    for (const candidate of candidates) {
      /**
       * ⚠️ Per-colleague, and a failure never leaves the loop. One colleague whose model is
       * unreachable must not cost every other colleague their update — a sweep that aborted on the
       * first error would leave the whole roster stale because of one misconfigured agent, and the
       * stalest-first order means it would be the same one every time.
       */
      const outcome = yield* Effect.gen(function* () {
        const text = yield* deps.recent(candidate.agent)
        // Nothing to summarise. Not a failure and not a refresh: the colleague's activity is real
        // (that is why it is due) but carries no text — tool-only work, for instance.
        if (!text) return "skipped" as const
        const task = yield* deps.label(candidate.agent, text)
        // ⚠️ A model that returns nothing usable leaves the PREVIOUS line standing. Writing an empty
        // or placeholder line here is how a colleague ends up described by a failure.
        if (!task) return "skipped" as const
        // `observed` is the activity this label covers — `candidate.latest`, not `now`. Keyed on the
        // clock, a colleague that stopped working would look freshly summarised forever.
        yield* deps.write({ agent: candidate.agent, task, observed: candidate.latest! })
        return "refreshed" as const
      }).pipe(Effect.catchCause(() => Effect.succeed("failed" as const)))

      if (outcome === "refreshed") refreshed++
      else if (outcome === "skipped") skipped++
      else failed++
    }

    return { refreshed, skipped, failed }
  })
