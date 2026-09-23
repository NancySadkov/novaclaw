export * as AgentLifecycle from "./lifecycle"

import { and, eq, isNull } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Log } from "@novaclaw/schema/log"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "../session/execution"
import { SessionExecutionAttempt } from "../session/execution-attempt"
import { SessionInput } from "../session/input"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { SessionStore } from "../session/store"
import { GraphRegistry } from "./graph-registry"

export interface Change {
  readonly agentID: string
  readonly paused: boolean
}

type Listener = { readonly apply: (change: Change) => Effect.Effect<void> }
const listeners = GraphRegistry.make<Listener>()

export const register = (apply: Listener["apply"]) => listeners.register({ apply })

/** Config is already committed at this boundary. A lifecycle fault is reported and contained; the
 * next toggle or boot recovery can retry it without lying that the saved setting rolled back. */
export const announce = (change: Change): Effect.Effect<void> =>
  Effect.flatMap(listeners.visible, (live) =>
    Effect.forEach(
      live,
      (listener) =>
        listener.apply(change).pipe(
          Effect.catchCause((cause) =>
            Log.event("config.runtime.reload.failed", {
              "config.domains": ["agent-lifecycle"],
              "config.causes": [Log.fault(cause)],
            }),
          ),
        ),
      { discard: true },
    ),
  )

export interface Runtime {
  readonly roots: (agentID: string) => Effect.Effect<readonly SessionSchema.ID[]>
  readonly get: SessionStore.Interface["get"]
  readonly children: SessionStore.Interface["children"]
  readonly attempt: SessionExecutionAttempt.Interface["get"]
  readonly hasQueuedInput: (id: SessionSchema.ID) => Effect.Effect<boolean>
  readonly interrupt: SessionExecution.Interface["interrupt"]
  readonly adopt: SessionExecution.Interface["adopt"]
}

/** Propagate one officer lifecycle transition through its temporary execution limbs. */
export const propagate = (change: Change, runtime: Runtime): Effect.Effect<void> =>
  Effect.gen(function* () {
    const roots = yield* runtime.roots(change.agentID)
    if (change.paused) {
      // Interrupting a root is already recursive and snapshots children only after the parent is
      // stopped, so a late spawn cannot escape the pause.
      yield* Effect.forEach(roots, runtime.interrupt, { discard: true, concurrency: "unbounded" })
      return
    }

    const visited = new Set<SessionSchema.ID>()
    const resumeBranch = (id: SessionSchema.ID, root: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (visited.has(id)) return
        visited.add(id)
        const session = yield* runtime.get(id)
        if (session === undefined || session.time.archived !== undefined) return
        const attempt = yield* runtime.attempt(id)
        // A named root chat is normally unfinished while simply idle; do not invent a turn.
        // Workers, and a root whose execution was interrupted by Pause, had real work to resume.
        const queued = yield* runtime.hasQueuedInput(id)
        if (queued || (session.result === undefined && (!root || attempt?.state === "interrupted"))) yield* runtime.adopt(id)
        const children = yield* runtime.children(id)
        yield* Effect.forEach(children, (child) => resumeBranch(child, false), {
          discard: true,
          concurrency: "unbounded",
        })
      })
    yield* Effect.forEach(roots, (root) => resumeBranch(root, true), {
      discard: true,
      concurrency: "unbounded",
    })
  })

export const node = makeGlobalNode({
  name: "agent/lifecycle",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const execution = yield* SessionExecution.Service
      const attempts = yield* SessionExecutionAttempt.Service
      const store = yield* SessionStore.Service
      const roots = (agentID: string) =>
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
          )
      yield* register((change) =>
        propagate(change, {
          roots,
          get: store.get,
          children: store.children,
          attempt: attempts.get,
          hasQueuedInput: (id) => SessionInput.hasPending(db, id, "queue"),
          interrupt: execution.interrupt,
          adopt: execution.adopt,
        }),
      )
    }),
  ),
  deps: [Database.node, SessionExecution.node, SessionExecutionAttempt.node, SessionStore.node],
})
