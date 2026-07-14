export * as ReferenceConfigStore from "./reference-config-store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { ReferenceConfigTable } from "./reference-config/sql"
import { ConfigReference } from "./config/reference"

// Config→SQLite step 4: the instance-wide, SQLite-backed source of truth for config-borne
// reference aliases (the catalog/agent/command-store template). Global so every directory —
// including the shared scratch dir — resolves the same references. jsonc becomes import/export
// only: the config-reference plugin seeds this store from an existing novaclaw.jsonc on first
// boot (transitional — removed in migration step 8).
export interface Interface {
  /** Every stored alias's config layers, keyed by alias (apply in order — last wins). */
  readonly references: () => Effect.Effect<Record<string, ConfigReference.Entry[]>>
  /** Insert or replace the full ordered layer list for one alias. */
  readonly setLayers: (name: string, layers: ConfigReference.Entry[]) => Effect.Effect<void>
  /** Remove one alias's stored config. */
  readonly removeReference: (name: string) => Effect.Effect<void>
  /** True when no references are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ReferenceConfigStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeLayers = Schema.decodeUnknownSync(Schema.Array(ConfigReference.Entry))

    return Service.of({
      references: Effect.fn("ReferenceConfigStore.references")(function* () {
        const rows = yield* db.select().from(ReferenceConfigTable).all().pipe(Effect.orDie)
        const result: Record<string, ConfigReference.Entry[]> = {}
        for (const row of rows) result[row.name] = [...decodeLayers(row.layers)]
        return result
      }),
      setLayers: Effect.fn("ReferenceConfigStore.setLayers")(function* (name, layers) {
        yield* db
          .insert(ReferenceConfigTable)
          .values({ name, layers })
          .onConflictDoUpdate({ target: ReferenceConfigTable.name, set: { layers } })
          .run()
          .pipe(Effect.orDie)
      }),
      removeReference: Effect.fn("ReferenceConfigStore.removeReference")(function* (name) {
        yield* db.delete(ReferenceConfigTable).where(eq(ReferenceConfigTable.name, name)).run().pipe(Effect.orDie)
      }),
      isEmpty: Effect.fn("ReferenceConfigStore.isEmpty")(function* () {
        const row = yield* db.select().from(ReferenceConfigTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
