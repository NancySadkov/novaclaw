export * as TurnTiming from "./turn-timing"

import type { SessionMessage } from "@novaclaw/schema/session-message"

type Phase = SessionMessage.TurnPhase
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
    phases: phases.map((phase) => ({ ...phase })),
    providerAttempts: attempts.map((attempt) => ({ ...attempt })),
  })

  return { start, end, queued, admitted, attemptStarted, firstToken, attemptSettled, snapshot }
}

export type Recorder = ReturnType<typeof make>
