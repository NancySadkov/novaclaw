import type { SessionMessageAssistant } from "@novaclaw/sdk/v2"
import * as Timestamp from "@novaclaw/schema/time"

export type TurnTiming = NonNullable<SessionMessageAssistant["timing"]>
export type TurnPhaseTiming = TurnTiming["phases"][number]
export type ProviderAttemptTiming = TurnTiming["providerAttempts"][number]

/**
 * Phases nothing records any more, kept because turns stored before their split still carry them.
 *
 * They are named here rather than only commented, because the one-label-per-phase rule below has to
 * hold for the phases a SINGLE turn can contain, and a retired name never co-occurs with the names
 * that replaced it — an old turn has `snapshot`, a new one has `snapshot-before`/`-after`, never
 * both. Without this set the rule would force a retired label to be reworded, which would rewrite
 * the history it exists to render.
 */
export const RETIRED_PHASES = new Set(["prepare", "snapshot"])

const LABELS = {
  // Retired 2026-08-11 — kept because stored turns from before the split still carry it (see the
  // schema's note). Nothing records it now.
  prepare: "Preparing your prompt",
  "context-load": "Gathering the conversation",
  "request-build": "Building the request",
  "context-fit": "Fitting the context window",
  "memory-embed": "Preparing recall",
  "memory-search": "Recalling",
  "memory-rerank": "Choosing useful memories",
  compaction: "Compacting the conversation",
  // Retired 2026-08-11 with the same reasoning as `prepare`: stored turns still carry it.
  snapshot: "Checking your files",
  "snapshot-before": "Checking your files",
  "snapshot-after": "Checking what changed",
  "scheduler-wait": "Waiting for a turn",
  "provider-setup": "Preparing the model",
  "provider-prefill": "Waiting for the model",
  generation: "Writing the answer",
  "capability-queue": "Waiting for a service",
  "capability-load": "Starting a service",
  "capability-run": "Running a service",
} satisfies Record<TurnPhaseTiming["phase"], string>

const DETAIL_LABELS = {
  repository: "Repository",
  status: "Status scan",
  persist: "Snapshot index",
  hash: "Tree hash",
} satisfies Record<NonNullable<TurnPhaseTiming["details"]>[number]["phase"], string>

/** Exposed so the test can assert the whole map is one-label-per-phase. */
export const phaseLabels = LABELS
export const phaseLabel = (phase: TurnPhaseTiming["phase"]) => LABELS[phase]
export const detailLabel = (phase: NonNullable<TurnPhaseTiming["details"]>[number]["phase"]) => DETAIL_LABELS[phase]

export const elapsedMs = (startedAt: unknown, completedAt: unknown, now: unknown): number | undefined => {
  const elapsed = Timestamp.elapsedMillis(startedAt, completedAt ?? now)
  return elapsed === undefined ? undefined : Math.max(0, elapsed)
}

/** A settled run's user-facing duration, normalized without ever leaking NaN or clock skew. */
export const completedRunSeconds = (startedAt: unknown, completedAt: unknown): string | undefined => {
  if (completedAt === undefined || completedAt === null) return undefined
  return seconds(elapsedMs(startedAt, completedAt, completedAt))
}

/**
 * How long a stage may run before the receipt says something about it.
 *
 * A ticking counter answers "is it stuck?" and nothing else. Past this point the honest question is
 * no longer whether anything is happening — the SSE stream heartbeats every 15 s and a dead server
 * raises the reconnect banner — but *why this is slow*, which a number cannot answer.
 */
export const LONG_STAGE_MS = 10_000

/**
 * What to say about a stage that is taking a while, or `undefined` while it is still ordinary.
 *
 * Every line names a REAL cause the user could act on or wait out. Nothing here says "please wait"
 * or "almost done": a reassurance that carries no information is the thing this replaces, and a
 * guess about progress we cannot see would be describing a fault falsely.
 */
export const longStageNote = (phase: TurnPhaseTiming["phase"], elapsed: number | undefined): string | undefined => {
  if (elapsed === undefined) return undefined
  if (elapsed < LONG_STAGE_MS) return undefined
  switch (phase) {
    case "scheduler-wait":
      return "Another session is using this model — this one starts when a slot frees up."
    case "provider-prefill":
      return "The agent is working on the request. Large images and files can take time."
    case "capability-load":
      return "Starting a service for the first time — later turns skip this."
    case "compaction":
      // The compaction audit row owns live progress from Started onward and survives reload. A
      // second phase note here duplicated it after ten seconds and was the transient row that
      // disappeared on navigation.
      return undefined
    case "context-load":
    case "context-fit":
      return "A long conversation takes longer to assemble."
    // ⚠️ These three were MISSING from this map until a live turn showed "Checking what changed…"
    // sitting at 10.6 s (2026-08-11). The unit tests could not have found that: they prove each note
    // is honest, not that the slow stages are the ones covered. If you add a phase, watch a real
    // turn before deciding it never runs long.
    //
    // ⚠️ And the wording is hedged ON PURPOSE. Every primitive behind this stage was then measured
    // warm at 85–160 ms on both this repository and a larger one, so that 10.6 s has no established
    // cause — naming one here would be describing a fault falsely (ruling 2). It says what the stage
    // does and that it is normally quick, which is what we actually know.
    case "snapshot":
    case "snapshot-before":
    case "snapshot-after":
      return "Comparing the working folder against the last snapshot. This is normally quick — a very large project or a busy disk makes it slower."
    default:
      return undefined
  }
}

export const seconds = (milliseconds: unknown): string | undefined =>
  typeof milliseconds === "number" && Number.isFinite(milliseconds) ? `${(milliseconds / 1000).toFixed(1)}s` : undefined

export const currentPhase = (timing: TurnTiming) => timing.phases.findLast((phase) => !phase.completedAt)

export const attemptLabel = (attempt: ProviderAttemptTiming) => {
  if (attempt.outcome === "retry") return `Retrying after attempt ${attempt.attempt}`
  if (attempt.outcome === "failed") return `Attempt ${attempt.attempt} failed`
  if (attempt.outcome === "interrupted") return `Attempt ${attempt.attempt} interrupted`
  return `Model attempt ${attempt.attempt}`
}

/**
 * What stands in for the ANSWER when a settled turn produced no prose.
 *
 * ## The defect this closes
 *
 * 57% of tool-bearing turns end without a closing message (measured 2026-08-11 over stored history,
 * `tests/turn-closing-history.ts`). The transcript refuses to fold those — `Turn`'s `folds()` requires
 * `hasAnswer()`, because `answerStart`'s contract is *do not fold a turn that has nothing to show in
 * its place*. Correct as far as it goes, and the result is the opposite of the owner's ruling: more
 * than half of all tool-bearing turns render their raw internals in full, which is precisely the wall
 * of tool output the Done fold exists to hide.
 *
 * ⚠️ **The other repair was tried and failed.** A kernel instruction telling the model to always
 * close with prose shipped and was CUT the same day when its pre-registered kill rule fired — median
 * answer length rose, no-answer rose. `system-compose.ts` records why, and says not to re-add a
 * "be brief" line. So this is the renderer's problem, and the renderer solves it without asking the
 * model for anything: give the fold something TRUE to show, and it may fold.
 *
 * ## What it may say
 *
 * Only what the transcript actually knows: the turn settled, it ran N tools, and its last message
 * carried no trailing prose. It must not guess why. A turn that ends on `exit(result)` ended
 * deliberately and already carries its terminal answer, so that result is shown; a bare `exit()`
 * falls back to a truthful finish line rather than being described as stopping short (ruling 2).
 */
export const turnOutcome = (input: {
  readonly toolCount: number
  readonly lastTool?: { readonly name: string; readonly result: string | undefined }
}): string | undefined => {
  if (input.toolCount <= 0) return undefined
  if (input.lastTool?.name === "exit") return input.lastTool.result?.trim() || "Finished."
  return "The model ended here without writing a reply."
}
