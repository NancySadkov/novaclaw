export * as NudgeService from "./nudge-service"

import { ne } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { SettingsConfigStore } from "./settings-config-store"
import { ConfigNudge } from "./config/nudge"
import { Nudge } from "./nudge"
import { NudgeDeliveryTable } from "./nudge-delivery.sql"

export interface Interface {
  /** Read settings through to SQLite, select applicable definitions, and atomically claim each new
   * occurrence for this session. A claimed match is safe to lower through SessionInput.steer once. */
  readonly claim: (input: {
    readonly sessionID: string
    readonly agentID?: string
    readonly event: Nudge.Event
  }) => Effect.Effect<ReadonlyArray<ConfigNudge.Info>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/NudgeService") {}

const decode = Schema.decodeUnknownOption(ConfigNudge.List)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const settings = yield* SettingsConfigStore.Service
    return Service.of({
      claim: Effect.fn("NudgeService.claim")(function* (input) {
        const stored = (yield* settings.all()).nudges
        const decoded = stored === undefined ? undefined : decode(stored)
        // Malformed settings are ignored rather than taking down the turn. The config HTTP boundary
        // rejects new malformed values; this arm exists for damaged/older stores and keeps defaults
        // from silently overriding a user's unreadable array.
        const definitions = stored === undefined ? Nudge.defaults() : decoded?._tag === "Some" ? decoded.value : []
        const selected = Nudge.select(definitions, input.event, input.agentID)
        const claimed: ConfigNudge.Info[] = []
        for (const match of selected) {
          const now = Date.now()
          const recorded = yield* db
            .insert(NudgeDeliveryTable)
            .values({
              session_id: input.sessionID,
              nudge_id: match.nudge.id,
              occurrence: match.occurrence,
              fired_at: now,
            })
            .onConflictDoUpdate({
              target: [NudgeDeliveryTable.session_id, NudgeDeliveryTable.nudge_id],
              set: { occurrence: match.occurrence, fired_at: now },
              setWhere: ne(NudgeDeliveryTable.occurrence, match.occurrence),
            })
            .returning({ occurrence: NudgeDeliveryTable.occurrence })
            .get()
            .pipe(Effect.orDie)
          if (!recorded) continue
          claimed.push(match.nudge)
        }
        return claimed
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(SettingsConfigStore.defaultLayer),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, SettingsConfigStore.node] })
