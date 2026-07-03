/**
 * TG-EEVDF — Turn-Granular EEVDF with cache-affinity hysteresis (notes/scheduler.md).
 *
 * The device picker for agent-session turns against ONE LLM device. EEVDF (the Linux
 * 6.6+ fair scheduler) adapted to non-preemptible LLM turns:
 *   - virtual time V advances by service/totalWeight; each session's vruntime advances
 *     by its consumed cost / weight — LAG (V − vruntime)·weight is the fairness debt;
 *   - ELIGIBLE = lag ≥ 0 (a session that over-consumed waits until virtual time
 *     catches up — overruns self-correct without preemption);
 *   - among eligible, pick the earliest VIRTUAL DEADLINE (vruntime + slice/weight):
 *     a short slice buys LATENCY (frequent turns), not SHARE — the interactive lever;
 *   - waiting sessions' lag grows structurally: aging without boost timers, and any
 *     nonzero weight excludes starvation (the cron floor);
 *   - CACHE AFFINITY is a BOUNDED bonus (hysteresis), never the ordering key — pure
 *     affinity-first scheduling provably starves cold sessions (k-LPM finding);
 *   - blocked sessions keep their debt (no laundering over-consumption through brief
 *     sleeps); blocked longer than the forgiveness TTL wake with lag reset to 0
 *     (no windfall credit — and stale warmth is zeroed the same way).
 *
 * Pure data structure (cost unit: TOKENS — measured per turn). Wiring charges it from
 * usage at turn end and consults pick() at dispatch. No Effect, fully unit-testable.
 */
export * as KernelEevdf from "./eevdf"

export type SessionClass =
  | "interactive-focused"
  | "interactive"
  | "sub-agent"
  | "goal-oriented"
  | "auto-prompting"
  | "cron"

export interface ClassParams {
  readonly weight: number
  readonly sliceTokens: number
}

/** Weights = share; slices = latency class (small slice → earlier deadlines). */
export const CLASS_PARAMS: Record<SessionClass, ClassParams> = {
  "interactive-focused": { weight: 100, sliceTokens: 2_000 },
  interactive: { weight: 50, sliceTokens: 4_000 },
  "sub-agent": { weight: 40, sliceTokens: 8_000 },
  "goal-oriented": { weight: 20, sliceTokens: 32_000 },
  "auto-prompting": { weight: 10, sliceTokens: 32_000 },
  // Never 0: tiny positive weight drains on idle but cannot be starved forever.
  cron: { weight: 5, sliceTokens: 32_000 },
}

export interface Candidate {
  readonly id: string
  /** Estimated resident prefix tokens for this session (the warmth model's output). */
  readonly warmthTokens?: number
}

export interface PickOptions {
  /** Affinity bonus scale (virtual-token units per warm token). */
  readonly beta?: number
  /** Hysteresis bound: the bonus can never exceed this many virtual tokens. */
  readonly capTokens?: number
}

export const DEFAULT_BETA = 0.5
export const DEFAULT_CAP_TOKENS = 8_000
export const DEFAULT_FORGIVENESS_MS = 5 * 60 * 1000

interface Entry {
  weight: number
  sliceTokens: number
  vruntime: number
  blockedAt?: number
}

export class Ledger {
  private readonly entries = new Map<string, Entry>()
  private virtual = 0
  private readonly forgivenessMs: number

  constructor(options?: { forgivenessMs?: number }) {
    this.forgivenessMs = options?.forgivenessMs ?? DEFAULT_FORGIVENESS_MS
  }

  /** Register (or re-class) a session. New sessions start at the current virtual time. */
  ensure(id: string, sessionClass: SessionClass, overrides?: Partial<ClassParams>): void {
    const params = CLASS_PARAMS[sessionClass]
    const existing = this.entries.get(id)
    if (existing) {
      existing.weight = overrides?.weight ?? params.weight
      existing.sliceTokens = overrides?.sliceTokens ?? params.sliceTokens
      return
    }
    this.entries.set(id, {
      weight: overrides?.weight ?? params.weight,
      sliceTokens: overrides?.sliceTokens ?? params.sliceTokens,
      vruntime: this.virtual,
    })
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Charge a finished turn's measured cost (tokens). Advances virtual time. */
  charge(id: string, costTokens: number): void {
    const entry = this.entries.get(id)
    if (!entry || costTokens <= 0) return
    entry.vruntime += costTokens / entry.weight
    const total = this.totalWeight()
    if (total > 0) this.virtual += costTokens / total
  }

  lag(id: string): number {
    const entry = this.entries.get(id)
    if (!entry) return 0
    return (this.virtual - entry.vruntime) * entry.weight
  }

  eligible(id: string): boolean {
    return this.lag(id) >= 0
  }

  virtualDeadline(id: string): number {
    const entry = this.entries.get(id)
    if (!entry) return Number.POSITIVE_INFINITY
    // max(vruntime, V): a long-idle session's deadline is anchored to NOW, not the past.
    return Math.max(entry.vruntime, this.virtual) + entry.sliceTokens / entry.weight
  }

  /** Deadline pressure: shrink the slice as a wall-clock deadline approaches (EEVDF-native EDF). */
  setSlice(id: string, sliceTokens: number): void {
    const entry = this.entries.get(id)
    if (entry) entry.sliceTokens = Math.max(1, sliceTokens)
  }

  onBlock(id: string, now: number): void {
    const entry = this.entries.get(id)
    if (entry) entry.blockedAt = now
  }

  /** Wake: debt persists across brief blocks; long blocks are forgiven (lag reset to 0). */
  onWake(id: string, now: number): { forgiven: boolean } {
    const entry = this.entries.get(id)
    if (!entry) return { forgiven: false }
    const blockedFor = entry.blockedAt === undefined ? 0 : now - entry.blockedAt
    entry.blockedAt = undefined
    if (blockedFor > this.forgivenessMs) {
      entry.vruntime = this.virtual
      return { forgiven: true }
    }
    return { forgiven: false }
  }

  /**
   * Pick the next session to dispatch: eligible-only, earliest virtual deadline,
   * minus a CAPPED warmth bonus. If nothing is eligible (all in debt), fall back to
   * the least-indebted candidate — the device should never idle while work waits.
   */
  pick(candidates: readonly Candidate[], options?: PickOptions): string | undefined {
    if (candidates.length === 0) return undefined
    const beta = options?.beta ?? DEFAULT_BETA
    const cap = options?.capTokens ?? DEFAULT_CAP_TOKENS
    const known = candidates.filter((candidate) => this.entries.has(candidate.id))
    if (known.length === 0) return undefined
    const eligible = known.filter((candidate) => this.eligible(candidate.id))
    const pool = eligible.length > 0 ? eligible : known
    let best: { id: string; score: number } | undefined
    for (const candidate of pool) {
      const entry = this.entries.get(candidate.id)!
      const bonus = Math.min((candidate.warmthTokens ?? 0) * beta, cap) / entry.weight
      const score =
        eligible.length > 0 ? this.virtualDeadline(candidate.id) - bonus : -this.lag(candidate.id)
      if (!best || score < best.score) best = { id: candidate.id, score }
    }
    return best?.id
  }

  /** Debug/introspection view (the ps-app story: one query surface for humans/agents/tests). */
  snapshot(): ReadonlyArray<{ id: string; weight: number; sliceTokens: number; lag: number; vdeadline: number }> {
    return [...this.entries.keys()].map((id) => ({
      id,
      weight: this.entries.get(id)!.weight,
      sliceTokens: this.entries.get(id)!.sliceTokens,
      lag: this.lag(id),
      vdeadline: this.virtualDeadline(id),
    }))
  }

  private totalWeight(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.weight
    return total
  }
}
