export * as InstanceIdentityStore from "./instance-identity-store"

import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import * as Id from "./id/id"
import { InstanceIdentityTable } from "./instance-identity/sql"

// Remote-access R7: the instance-wide durable identity. `get()` returns the stored id, minting
// one (`ins_…`) on first read — so every instance has a stable id from its first boot with no
// seed step. Advertised over mDNS and reported by /global/health so clients can recognize the
// SAME instance behind different URLs (mDNS name vs IP vs tunnel).
export interface Interface {
  /** The instance's stable id — minted once on first read, immutable after. */
  readonly get: () => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/InstanceIdentityStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      get: Effect.fn("InstanceIdentityStore.get")(function* () {
        const existing = yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie)
        if (existing) return existing.id
        const id = Id.create("ins", "ascending")
        // Two concurrent first reads race benignly: the second insert conflicts and the
        // stored winner is re-read — the id stays stable either way.
        yield* db.insert(InstanceIdentityTable).values({ id }).onConflictDoNothing().run().pipe(Effect.orDie)
        const row = yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie)
        return row?.id ?? id
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
