export * as TurnTiming from "./turn-timing"

import type { SessionMessage } from "@novaclaw/schema/session-message"

type Phase = SessionMessage.TurnPhase
type SnapshotPhase = SessionMessage.SnapshotPhase
type AttemptOutcome = SessionMessage.ProviderAttemptTiming["outcome"]

/**
 * One turn's server-owned monotonic ledger. It intentionally stores epoch milliseconds on the wire:
 * reconnect/replay can render the same receipt, while durations are derived without trusting a
 * browser clock. Repeated phase names and provider attempts remain separate ordered records.
 */
export const make = (now: () => number = Date.now) => {
  const startedAt = now()
  const phases: SessionMessage.TurnPhaseTiming[] = []
  const attempts: SessionMessage.ProviderAttemptTiming[] = []
  const open = new Map<Phase, number[]>()
  const openSnapshotDetails = new Map<SnapshotPhase, Array<{ phase: number; detail: number }>>()
  let firstTokenRecorded = false

  const start = (phase: Phase) => {
    const at = now()
    phases.push({ phase, startedAt: at })
    const indexes = open.get(phase) ?? []
    indexes.push(phases.length - 1)
    open.set(phase, indexes)
  }
  const end = (phase: Phase) => {
    const indexes = open.get(phase)
    const index = indexes?.pop()
    if (index === undefined) return
    phases[index] = { ...phases[index]!, completedAt: now() }
    if (indexes?.length === 0) open.delete(phase)
  }
  const detailStart = (detail: SnapshotPhase) => {
    const phase = open.get("snapshot")?.at(-1)
    if (phase === undefined) return
    const details = [...(phases[phase]?.details ?? []), { phase: detail, startedAt: now() }]
    phases[phase] = { ...phases[phase]!, details }
    const indexes = openSnapshotDetails.get(detail) ?? []
    indexes.push({ phase, detail: details.length - 1 })
    openSnapshotDetails.set(detail, indexes)
  }
  const detailEnd = (detail: SnapshotPhase) => {
    const indexes = openSnapshotDetails.get(detail)
    const index = indexes?.pop()
    if (!index) return
    const details = [...(phases[index.phase]?.details ?? [])]
    details[index.detail] = { ...details[index.detail]!, completedAt: now() }
    phases[index.phase] = { ...phases[index.phase]!, details }
    if (indexes?.length === 0) openSnapshotDetails.delete(detail)
  }
  const queued = () => start("scheduler-wait")
  const admitted = () => end("scheduler-wait")
  const attemptStarted = (attempt: number) => {
    firstTokenRecorded = false
    start("provider-prefill")
    attempts.push({ attempt, dispatchedAt: now(), outcome: "running" })
  }
  const firstToken = () => {
    if (firstTokenRecorded) return
    firstTokenRecorded = true
    end("provider-prefill")
    start("generation")
    const current = attempts.at(-1)
    if (current) attempts[attempts.length - 1] = { ...current, firstTokenAt: now() }
  }
  const attemptSettled = (attempt: number, outcome: AttemptOutcome) => {
    end("provider-prefill")
    end("generation")
    const index = attempts.findLastIndex((item) => item.attempt === attempt)
    if (index < 0) return
    attempts[index] = { ...attempts[index]!, completedAt: now(), outcome }
  }
  const snapshot = (): SessionMessage.TurnTiming => ({
    startedAt,
    completedAt: now(),
    phases: phases.map((phase) => ({
      ...phase,
      ...(phase.details ? { details: phase.details.map((detail) => ({ ...detail })) } : {}),
    })),
    providerAttempts: attempts.map((attempt) => ({ ...attempt })),
  })

  return { start, end, detailStart, detailEnd, queued, admitted, attemptStarted, firstToken, attemptSettled, snapshot }
}

export type Recorder = ReturnType<typeof make>
