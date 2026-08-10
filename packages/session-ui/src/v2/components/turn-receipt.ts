import type { SessionMessageAssistant } from "@novaclaw/sdk/v2"

export type TurnTiming = NonNullable<SessionMessageAssistant["timing"]>
export type TurnPhaseTiming = TurnTiming["phases"][number]
export type ProviderAttemptTiming = TurnTiming["providerAttempts"][number]

const LABELS = {
  prepare: "Preparing your prompt",
  "memory-embed": "Preparing recall",
  "memory-search": "Recalling",
  "memory-rerank": "Choosing useful memories",
  compaction: "Compacting the conversation",
  snapshot: "Checking your files",
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
