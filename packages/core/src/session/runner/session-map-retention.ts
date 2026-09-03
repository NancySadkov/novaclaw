/**
 * Lazy retention for runner controller state keyed by session id.
 *
 * The runner deliberately keeps some facts across drains because compaction and steering can
 * replace the transcript window that originally carried them. Keeping those facts forever,
 * however, makes every completed session a process-lifetime allocation. This guard gives all of
 * those maps the scheduler's forgiveness window without adding a timer: entering or leaving a
 * drain sweeps sessions that have been idle past the window, while every active drain stays pinned.
 */
export * as SessionMapRetention from "./session-map-retention"

import { Effect } from "effect"
import { KernelEevdf } from "../../kernel/eevdf"

export interface Store {
  readonly delete: (sessionID: string) => boolean
}

export interface Options {
  readonly now?: () => number
  readonly forgivenessMs?: number
}

export interface Interface {
  readonly withSession: <A, E, R>(sessionID: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /**
   * The two halves of `withSession`, for a caller whose run is not one Effect: the host pins a
   * session when it spawns the worker for a drain and releases it from the worker's exit hook
   * (`session-worker/execution.ts`). Always pair them; an unreleased pin is a session that is never
   * swept.
   */
  readonly acquire: (sessionID: string) => void
  readonly release: (sessionID: string) => void
}

export const make = (stores: readonly Store[], options?: Options): Interface => {
  const now = options?.now ?? (() => Date.now())
  const forgivenessMs = options?.forgivenessMs ?? KernelEevdf.DEFAULT_FORGIVENESS_MS
  const active = new Map<string, number>()
  const blockedAt = new Map<string, number>()

  const evict = (sessionID: string) => {
    blockedAt.delete(sessionID)
    for (const store of stores) store.delete(sessionID)
  }

  const sweep = (at: number) => {
    const stale: string[] = []
    for (const [sessionID, since] of blockedAt) {
      if (active.has(sessionID) || at - since <= forgivenessMs) continue
      stale.push(sessionID)
    }
    for (const sessionID of stale) evict(sessionID)
  }

  const acquire = (sessionID: string) => {
    const at = now()
    // Sweep before pinning the newcomer. A session returning after the forgiveness window starts
    // fresh, which may repeat visible steering but can never silently mark unfinished work done.
    sweep(at)
    active.set(sessionID, (active.get(sessionID) ?? 0) + 1)
    blockedAt.delete(sessionID)
  }

  const release = (sessionID: string) => {
    const count = active.get(sessionID)
    if (count === undefined) return
    if (count > 1) {
      active.set(sessionID, count - 1)
      return
    }
    active.delete(sessionID)
    blockedAt.set(sessionID, now())
    sweep(now())
  }

  const withSession: Interface["withSession"] = (sessionID, effect) =>
    Effect.acquireUseRelease(
      Effect.sync(() => acquire(sessionID)),
      () => effect,
      () => Effect.sync(() => release(sessionID)),
    )

  return { withSession, acquire, release }
}
