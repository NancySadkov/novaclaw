import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionCompactionRequest } from "@novaclaw/core/session/compaction-request"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { testEffect } from "./lib/effect"

// The manual-compaction marker (`compaction-request.ts`). It was an in-memory Set, which stopped
// working the day sessions moved into their own worker PROCESS: `request` wrote the host's Set and
// `consume` read the worker's, so the Compact button did nothing at all — no compaction, and not
// even the "didn't run" notice, because the code that publishes it never ran.
//
// These drive TWO INDEPENDENT SERVICE INSTANCES over one database, which is the shape of the defect:
// same storage, different processes. Against the old implementation the cross-instance case cannot
// pass — two Sets never see each other.

const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database, SessionCompactionRequest.layer.pipe(Layer.provide(database))))

const session = SessionSchema.ID.make("ses_compact_marker")

describe("the manual compaction marker", () => {
  it.effect("survives the process boundary: requested by one instance, consumed by another", () =>
    Effect.gen(function* () {
      // The HOST asks…
      const host = yield* SessionCompactionRequest.Service
      yield* host.request(session)

      // …and a SECOND service instance over the same database — the worker — consumes it.
      const worker = yield* Effect.provide(
        SessionCompactionRequest.Service,
        SessionCompactionRequest.layer.pipe(Layer.provide(Layer.succeed(Database.Service, yield* Database.Service))),
      )
      expect(yield* worker.consume(session)).toBe(true)
    }),
  )

  it.effect("is ONE-SHOT: the second consume finds nothing", () =>
    Effect.gen(function* () {
      const marker = yield* SessionCompactionRequest.Service
      yield* marker.request(session)
      expect(yield* marker.consume(session)).toBe(true)
      // Two drains racing must not both compact — the DELETE is the consume, so the database decides.
      expect(yield* marker.consume(session)).toBe(false)
    }),
  )

  it.effect("consuming an unrequested session is false, not an error", () =>
    Effect.gen(function* () {
      const marker = yield* SessionCompactionRequest.Service
      // The drain asks on EVERY turn; "nobody pressed Compact" is the ordinary answer.
      expect(yield* marker.consume(SessionSchema.ID.make("ses_never_asked"))).toBe(false)
    }),
  )

  it.effect("pressing Compact twice is idempotent, never a failure", () =>
    Effect.gen(function* () {
      const marker = yield* SessionCompactionRequest.Service
      // The user cannot see whether the first press is still pending, so a second press means "yes,
      // compact" — not "error, already asked".
      yield* marker.request(session)
      yield* marker.request(session)
      expect(yield* marker.consume(session)).toBe(true)
      expect(yield* marker.consume(session)).toBe(false)
    }),
  )
})
