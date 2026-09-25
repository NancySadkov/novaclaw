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
  "model-recovery": "Waiting for the model to recover",
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
  "provider-prefill": "Loading the prompt into the model",
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

export type RecallInfo = NonNullable<TurnPhaseTiming["recall"]>

/**
 * One line under the recall stage saying what it FOUND, not only how long it took.
 *
 * The stage already had a label and a stopwatch, and that was not enough to answer the question it
 * was asked to answer: a 0.6 s recall is a healthy hybrid search over a full cabinet and a
 * keyword-only search over an empty one, and the degraded case is the FAST one. The counts are what
 * separate them, and they are also how a person can see recall spending its budget in a turn that
 * then took two minutes to prefill.
 *
 * ⚠️ Every number passes through `count` first. These arrive from a decoded stored row, which may
 * have been written by a build other than this one; a `~NaN tokens` in someone's transcript is not an
 * acceptable way to find out.
 */
export const recallNote = (recall: RecallInfo | undefined): string | undefined => {
  if (recall === undefined) return undefined
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  const head = `${count(recall.retrieved)} looked at, ${count(recall.shown)} shown`
  const cut = count(recall.omitted) > 0 ? `, ${count(recall.omitted)} did not fit` : ""
  const tokens = count(recall.tokens) > 0 ? ` · ~${count(recall.tokens)} tokens` : ""
  const degraded = [
    recall.vector === true ? undefined : "keywords only",
    recall.reranked === true ? undefined : "ranked without the model",
  ].filter((part): part is string => part !== undefined)
  return `${head}${cut}${tokens}${degraded.length > 0 ? ` · ${degraded.join(", ")}` : ""}`
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
export const longStageNote = (
  phase: TurnPhaseTiming["phase"],
  elapsed: number | undefined,
  context?: { imageAttachments?: number },
): string | undefined => {
  if (elapsed === undefined) return undefined
  if (elapsed < LONG_STAGE_MS) return undefined
  switch (phase) {
    case "scheduler-wait":
      return "Another session is using this model — this one starts when a slot frees up."
    case "provider-prefill":
      if (context?.imageAttachments === 1)
        return "The visual model is reading the attached image. Large images can take time."
      if ((context?.imageAttachments ?? 0) > 1)
        return "The visual model is reading the attached images. Large images can take time."
      return "Waiting for the model server..."
    case "model-recovery":
      return "The selected model is unavailable. NovaClaw will retry it when its recovery delay ends, or use a compatible healthy model if one becomes available."
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

/** Live status is ephemeral; durable execution keeps a recovered turn open across process boot. */
export const turnIsRunning = (status: string | undefined, executionOpen: boolean | undefined): boolean =>
  executionOpen ?? (status === "busy" || status === "retry")

/**
 * What stands in for the ANSWER when an accepted exit produced no trailing prose.
 *
 * ## What it may say
 *
 * Only what the transcript actually knows: the completion auditor accepted this exact exit and the
 * durable marker carries its result. A successful exit tool without that marker may have been
 * rejected and is not completion evidence. Absence of a live-status signal is never substituted.
 */
export const turnOutcome = (input: {
  readonly toolCount: number
  readonly acceptedExit?: { readonly result: string }
}): string | undefined => {
  if (input.toolCount <= 0 || input.acceptedExit === undefined) return undefined
  return input.acceptedExit.result.trim() || "Finished."
}
