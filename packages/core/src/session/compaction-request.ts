export * as SessionCompactionRequest from "./compaction-request"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionSchema } from "./schema"
import { SessionCompactionRequestTable } from "./compaction-request.sql"

/**
 * F1a SLICE 7 — the one-shot manual-compaction marker (architecture.md's kernel marker
 * vocabulary: an event is a component a phase consumes). `SessionV2.compact` REQUESTS and wakes
 * the session; the runner CONSUMES the marker at the top of its drain and runs a compact-only
 * cycle in its own context — compaction must run inside the runner because only it holds the
 * shared `LLMClient` (the OFF-C offline chokepoint), the resolved model, and the history
 * assembly (the inline `SessionV2.compact` build was reverted on exactly that constraint).
 *
 * 🔴 **DURABLE, and it had to become so — it was in-memory and the button did nothing.** The comment
 * that stood here said "in-memory by design: a request lost to a crash is simply re-issued by the
 * user". That was true when the runner shared a process with the HTTP surface. Sessions now drain
 * inside their own worker PROCESS, so `request` wrote to the host's Set and `consume` read the
 * worker's — two Sets, one of them always empty. Measured 2026-08-21: `POST /api/session/:id/compact`
 * answered 204, the session woke, drained, and compacted nothing; not even the "Compaction didn't
 * run" synthetic appeared, because the code that publishes it never ran. A Compact button that
 * silently does nothing is a broken button by this repo's own rule, and an in-memory marker is not
 * "lost to a crash" here — it is lost to a process boundary, every single time.
 *
 * One row per pending request, consumed by DELETING it, so "one-shot" is the database's guarantee
 * rather than a promise two processes make separately.
 */
export interface Interface {
  readonly request: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** One-shot: returns true exactly once per request. */
  readonly consume: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionCompactionRequest") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return Service.of({
      request: (sessionID) =>
        db
          .insert(SessionCompactionRequestTable)
          .values({ session_id: sessionID, requested_at: Date.now() })
          // Re-pressing Compact is idempotent rather than an error: the user cannot see whether the
          // first press is still pending, so pressing twice must mean "yes, compact" and not "fail".
          .onConflictDoUpdate({
            target: SessionCompactionRequestTable.session_id,
            set: { requested_at: Date.now() },
          })
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      consume: (sessionID) =>
        db
          .delete(SessionCompactionRequestTable)
          .where(eq(SessionCompactionRequestTable.session_id, sessionID))
          .returning({ session_id: SessionCompactionRequestTable.session_id })
          .all()
          // The DELETE is the consume: whoever removes the row is the one that runs the cycle, so two
          // drains racing cannot both compact.
          .pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.orDie,
          ),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
