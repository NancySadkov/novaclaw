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

  const begin = (phase: Phase) => {
    const at = now()
    phases.push({ phase, startedAt: at })
    const index = phases.length - 1
    const indexes = open.get(phase) ?? []
    indexes.push(index)
    open.set(phase, indexes)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      phases[index] = { ...phases[index]!, completedAt: now() }
      const current = open.get(phase)
      const position = current?.indexOf(index) ?? -1
      if (position >= 0) current!.splice(position, 1)
      if (current?.length === 0) open.delete(phase)
    }
  }
  const start = (phase: Phase) => {
    begin(phase)
  }
  /**
   * Close the newest open record for `phase` and RETURN it.
   *
   * The return value is what lets a caller notice that a stage ran long without keeping its own
   * stopwatch beside this ledger — two clocks for one stage is how they end up disagreeing. It also
   * hands back the sub-timings, which is the only thing that can say WHICH part was slow: a 10.6 s
   * "Checking what changed" was observed on 2026-08-11 and could not be explained afterwards,
   * because nothing had recorded the breakdown at the moment it happened.
   */
  const end = (phase: Phase): SessionMessage.TurnPhaseTiming | undefined => {
    const indexes = open.get(phase)
    const index = indexes?.pop()
    if (index === undefined) return undefined
    phases[index] = { ...phases[index]!, completedAt: now() }
    if (indexes?.length === 0) open.delete(phase)
    return phases[index]
  }
  /**
   * The snapshot phase a `repository`/`status`/`persist`/`hash` detail belongs to — the newest open
   * one across the whole family.
   *
   * 🔴 This used to read `open.get("snapshot")` by that literal name, so splitting the phase into
   * `snapshot-before` / `snapshot-after` (2026-08-11) would have silently dropped EVERY detail:
   * `detailStart` would find nothing, return early, and the developer receipt would lose its
   * sub-timings with nothing failing. Keeping the old name in the list is what makes a stored turn
   * still resolve, and taking the max index is what attributes a detail to the snapshot actually
   * running rather than to whichever family member was declared first.
   */
  const openSnapshotPhase = (): number | undefined => {
    let newest: number | undefined
    for (const name of ["snapshot", "snapshot-before", "snapshot-after"] as const) {
      const index = open.get(name)?.at(-1)
      if (index !== undefined && (newest === undefined || index > newest)) newest = index
    }
    return newest
  }
  const detailStart = (detail: SnapshotPhase) => {
    const phase = openSnapshotPhase()
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
  const read = (completed: boolean): SessionMessage.TurnTiming => ({
    startedAt,
    ...(completed ? { completedAt: now() } : {}),
    phases: phases.map((phase) => ({
      ...phase,
      ...(phase.details ? { details: phase.details.map((detail) => ({ ...detail })) } : {}),
    })),
    providerAttempts: attempts.map((attempt) => ({ ...attempt })),
  })
  const live = () => read(false)
  const snapshot = () => read(true)

  return {
    start,
    begin,
    end,
    detailStart,
    detailEnd,
    queued,
    admitted,
    attemptStarted,
    firstToken,
    attemptSettled,
    live,
    snapshot,
  }
}

export type Recorder = ReturnType<typeof make>
