export * as PluginConfigStore from "./plugin-config-store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { PluginConfigTable } from "./plugin-config/sql"

export type PluginConfigEntry = {
  package: string
  options?: Record<string, unknown>
}

// Config→SQLite step 5: the instance-wide, SQLite-backed source of truth for config-borne
// external plugin specs (the catalog/agent/command/skill-store template). Global so every
// directory — including the shared scratch dir — loads the same plugins. jsonc becomes
// import/export only: the config-plugin loader seeds this store from an existing
// novaclaw.jsonc on first boot (transitional — removed in migration step 8).
export interface Interface {
  /** Every stored plugin spec (normalized package + options), in insertion order. */
  readonly plugins: () => Effect.Effect<PluginConfigEntry[]>
  /** Insert or replace one spec (the package string is the identity; last write wins on options). */
  readonly setPlugin: (entry: PluginConfigEntry) => Effect.Effect<void>
  /** Remove one stored spec. */
  readonly removePlugin: (pkg: string) => Effect.Effect<void>
  /** True when no specs are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/PluginConfigStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      plugins: Effect.fn("PluginConfigStore.plugins")(function* () {
        const rows = yield* db.select().from(PluginConfigTable).all().pipe(Effect.orDie)
        return rows.map((row) => ({ package: row.package, ...(row.options ? { options: row.options } : {}) }))
      }),
      setPlugin: Effect.fn("PluginConfigStore.setPlugin")(function* (entry) {
        const options = entry.options ?? null
        yield* db
          .insert(PluginConfigTable)
          .values({ package: entry.package, options })
          .onConflictDoUpdate({ target: PluginConfigTable.package, set: { options } })
          .run()
          .pipe(Effect.orDie)
      }),
      removePlugin: Effect.fn("PluginConfigStore.removePlugin")(function* (pkg) {
        yield* db.delete(PluginConfigTable).where(eq(PluginConfigTable.package, pkg)).run().pipe(Effect.orDie)
      }),
      isEmpty: Effect.fn("PluginConfigStore.isEmpty")(function* () {
        const row = yield* db.select().from(PluginConfigTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
