export * as AgentWorkerCapacity from "./worker-capacity"

import { and, eq, isNull } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Log } from "@novaclaw/schema/log"
import { SessionExecution } from "../session/execution"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SessionTable } from "../session/sql"
import { WorkerControl } from "../session/worker-control"
import { WorkerPurpose } from "../session/worker-purpose"
import { GraphRegistry } from "./graph-registry"

export const DEFAULT_MAX_WORKERS = 100

export const limitOf = (config: { readonly maxWorkers?: number } | undefined): number =>
  config?.maxWorkers ?? DEFAULT_MAX_WORKERS

export const currentLimit = (configs: AgentConfigStore.Interface, agentID: string): Effect.Effect<number> =>
  Effect.map(configs.agents(), (stored) => limitOf(AgentConfigStore.fold(stored[agentID] ?? [])))

const locks = new WeakMap<object, KeyedMutex.KeyedMutex<string>>()

export const withOfficerLock = <A, E, R>(
  db: object,
  rootID: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  let lock = locks.get(db)
  if (lock === undefined) {
    lock = KeyedMutex.makeUnsafe<string>()
    locks.set(db, lock)
  }
  return lock.withLock(rootID)(effect)
}

export interface Change {
  readonly agentID: string
  readonly limit: number
}

type Listener = { readonly apply: (change: Change) => Effect.Effect<void> }
const listeners = GraphRegistry.make<Listener>()

export const register = (apply: Listener["apply"]) => listeners.register({ apply })

export const announce = (change: Change): Effect.Effect<void> =>
  Effect.flatMap(listeners.visible, (live) =>
    Effect.forEach(
      live,
      (listener) =>
        listener.apply(change).pipe(
          Effect.catchCause((cause) =>
            Log.event("config.runtime.reload.failed", {
              "config.domains": ["agent-worker-capacity"],
              "config.causes": [Log.fault(cause)],
            }),
          ),
        ),
      { discard: true },
    ),
  )

export interface WorkerRow {
  readonly id: SessionSchema.ID
  readonly parentID: SessionSchema.ID | null
  readonly result: unknown
  readonly archived: number | null
  readonly created: number
  readonly title: string
  readonly metadata: Record<string, unknown> | null
}

export const activeDescendants = (rootID: SessionSchema.ID, rows: readonly WorkerRow[]): WorkerRow[] => {
  const byParent = new Map<string, WorkerRow[]>()
  for (const row of rows) {
    if (row.parentID === null) continue
    const children = byParent.get(row.parentID) ?? []
    children.push(row)
    byParent.set(row.parentID, children)
  }
  const pending = [rootID as string]
  const visited = new Set<string>()
  const active: WorkerRow[] = []
  while (pending.length > 0) {
    const parent = pending.pop()!
    if (visited.has(parent)) continue
    visited.add(parent)
    for (const child of byParent.get(parent) ?? []) {
      if (child.result === null && child.archived === null) active.push(child)
      pending.push(child.id)
    }
  }
  return active
}

export interface Runtime {
  readonly roots: (agentID: string) => Effect.Effect<readonly SessionSchema.ID[]>
  readonly limit: (agentID: string) => Effect.Effect<number>
  readonly rows: () => Effect.Effect<readonly WorkerRow[]>
  readonly kill: (parentID: SessionSchema.ID, childID: SessionSchema.ID) => Effect.Effect<number | undefined>
  readonly notify: (rootID: SessionSchema.ID, text: string) => Effect.Effect<void>
}

export const enforce = (change: Change, runtime: Runtime, db: object): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const rootID of yield* runtime.roots(change.agentID)) {
      yield* withOfficerLock(db, rootID, Effect.void)
      const stopped: WorkerRow[] = []
      const attempted = new Set<SessionSchema.ID>()
      let currentLimit = change.limit
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          while (true) {
            currentLimit = yield* runtime.limit(change.agentID)
            const active = activeDescendants(rootID, yield* runtime.rows())
            if (active.length <= currentLimit) break
            const newest = active.sort((a, b) => b.created - a.created || String(b.id).localeCompare(String(a.id)))[0]!
            if (newest.parentID === null) return yield* Effect.die(new Error(`Worker ${newest.id} has no parent`))
            if (attempted.has(newest.id)) return yield* Effect.die(new Error(`Worker ${newest.id} remained active after stop`))
            attempted.add(newest.id)
            const killed = yield* runtime.kill(newest.parentID, newest.id)
            if (killed === undefined) {
              const stillActive = activeDescendants(rootID, yield* runtime.rows()).some(
                (worker) => worker.id === newest.id,
              )
              if (stillActive) return yield* Effect.die(new Error(`Worker ${newest.id} could not be stopped`))
              continue
            }
            stopped.push(newest)
          }
        }),
      )
      if (stopped.length > 0) {
        const details = stopped.map((worker) => {
          const purpose = WorkerPurpose.fromMetadata(worker.metadata)
          return `- ${worker.id} · ${worker.title}${purpose ? ` · ${purpose}` : ""}`
        })
        yield* runtime.notify(
          rootID,
          `Maximum active workers is now ${currentLimit}. The instance stopped ${stopped.length} excess worker${stopped.length === 1 ? "" : "s"}:\n${details.join("\n")}`,
        )
      }
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause)
    }
  })

export const node = makeGlobalNode({
  name: "agent/worker-capacity",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const execution = yield* SessionExecution.Service
      const store = yield* SessionStore.Service
      const configs = yield* AgentConfigStore.Service
      const runtime: Runtime = {
        roots: (agentID) =>
          db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              and(eq(SessionTable.agent, agentID), isNull(SessionTable.parent_id), isNull(SessionTable.time_archived)),
            )
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows.map((row) => SessionSchema.ID.make(row.id))),
            ),
        limit: (agentID) => currentLimit(configs, agentID),
        rows: () =>
          db
            .select({
              id: SessionTable.id,
              parentID: SessionTable.parent_id,
              result: SessionTable.result,
              archived: SessionTable.time_archived,
              created: SessionTable.time_created,
              title: SessionTable.title,
              metadata: SessionTable.metadata,
            })
            .from(SessionTable)
            .all()
            .pipe(Effect.orDie),
        kill: (parentID, childID) =>
          WorkerControl.kill({ parentID, childID, db, events, store, interrupt: execution.interrupt }),
        notify: (rootID, message) =>
          events.publish(SessionEvent.Synthetic, {
            sessionID: rootID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(Date.now()),
            text: message,
          }),
      }
      yield* register((change) => enforce(change, runtime, db))
      const stored = yield* configs.agents()
      for (const agentID of Object.keys(stored))
        yield* enforce({ agentID, limit: limitOf(AgentConfigStore.fold(stored[agentID] ?? [])) }, runtime, db)
    }),
  ),
  deps: [AgentConfigStore.node, Database.node, EventV2.node, SessionExecution.node, SessionStore.node],
})
