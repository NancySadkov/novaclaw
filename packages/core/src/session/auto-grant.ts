export * as SessionAutoGrant from "./auto-grant"

import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { PermissionMode } from "./config-resolve"
import { SessionSchema } from "./schema"
import { SessionAutoGrantTable } from "./sql"

export interface Grant {
  readonly mode: PermissionMode
  readonly justification: string
  readonly at: number
}

export interface Interface {
  readonly get: (sessionID: string) => Effect.Effect<Grant | undefined>
  readonly mode: (sessionID: string) => Effect.Effect<PermissionMode | undefined>
  readonly any: () => Effect.Effect<boolean>
  readonly set: (sessionID: string, grant: Grant) => Effect.Effect<void>
  /** Test-only reset. Production rows die with their session through the foreign-key cascade. */
  readonly clear: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionAutoGrant") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("SessionAutoGrant.get")(function* (sessionID: string) {
      const row = yield* db
        .select({
          mode: SessionAutoGrantTable.mode,
          justification: SessionAutoGrantTable.justification,
          at: SessionAutoGrantTable.at,
        })
        .from(SessionAutoGrantTable)
        .where(eq(SessionAutoGrantTable.session_id, SessionSchema.ID.make(sessionID)))
        .get()
        .pipe(Effect.orDie)
      return row
    })

    const mode = Effect.fn("SessionAutoGrant.mode")(function* (sessionID: string) {
      return (yield* get(sessionID))?.mode
    })

    const any = Effect.fn("SessionAutoGrant.any")(function* () {
      return (
        (yield* db
          .select({ present: sql<number>`1` })
          .from(SessionAutoGrantTable)
          .limit(1)
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const set = Effect.fn("SessionAutoGrant.set")(function* (sessionID: string, grant: Grant) {
      yield* db
        .insert(SessionAutoGrantTable)
        .values({ session_id: SessionSchema.ID.make(sessionID), ...grant })
        .onConflictDoUpdate({
          target: SessionAutoGrantTable.session_id,
          set: grant,
        })
        .run()
        .pipe(Effect.orDie)
    })

    const clear = Effect.fn("SessionAutoGrant.clear")(function* () {
      yield* db.delete(SessionAutoGrantTable).run().pipe(Effect.orDie)
    })

    return Service.of({ get, mode, any, set, clear })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
