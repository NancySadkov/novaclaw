import type { SessionMessageAssistant } from "@novaclaw/sdk/v2"

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

export const elapsedMs = (startedAt: number, completedAt: number | undefined, now: number) =>
  Math.max(0, (completedAt ?? now) - startedAt)

export const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)}s`

export const currentPhase = (timing: TurnTiming) => timing.phases.findLast((phase) => !phase.completedAt)

export const attemptLabel = (attempt: ProviderAttemptTiming) => {
  if (attempt.outcome === "retry") return `Retrying after attempt ${attempt.attempt}`
  if (attempt.outcome === "failed") return `Attempt ${attempt.attempt} failed`
  if (attempt.outcome === "interrupted") return `Attempt ${attempt.attempt} interrupted`
  return `Model attempt ${attempt.attempt}`
}
