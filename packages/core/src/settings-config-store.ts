export * as SettingsConfigStore from "./settings-config-store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeSettingTable } from "./settings-config/sql"

// Config→SQLite step 6: the instance-wide, SQLite-backed source of truth for runtime settings
// (the catalog/agent/command/skill/plugin-store template). Global so every directory — including
// the shared scratch dir — resolves the same settings. Readers stay untouched: the Config layer
// appends ONE synthetic document holding these values to `entries()`, so every
// `Config.latest(entries, key)` reader picks them up (findLast = most specific wins). jsonc
// becomes import/export only: the Config layer seeds this store from the location's config
// documents on first boot (transitional — removed in migration step 8).
export interface Interface {
  /** Every stored setting, keyed by the top-level config key. */
  readonly all: () => Effect.Effect<Record<string, unknown>>
  /** Insert or replace one setting's whole value (latest() semantics — no layers). */
  readonly set: (key: string, value: unknown) => Effect.Effect<void>
  /** Remove one stored setting (the key falls back to config documents until step 8). */
  readonly remove: (key: string) => Effect.Effect<void>
  /** True when no settings are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SettingsConfigStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      all: Effect.fn("SettingsConfigStore.all")(function* () {
        const rows = yield* db.select().from(RuntimeSettingTable).all().pipe(Effect.orDie)
        const result: Record<string, unknown> = {}
        for (const row of rows) result[row.key] = row.value
        return result
      }),
      set: Effect.fn("SettingsConfigStore.set")(function* (key, value) {
        yield* db
          .insert(RuntimeSettingTable)
          .values({ key, value })
          .onConflictDoUpdate({ target: RuntimeSettingTable.key, set: { value } })
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("SettingsConfigStore.remove")(function* (key) {
        yield* db.delete(RuntimeSettingTable).where(eq(RuntimeSettingTable.key, key)).run().pipe(Effect.orDie)
      }),
      isEmpty: Effect.fn("SettingsConfigStore.isEmpty")(function* () {
        const row = yield* db.select().from(RuntimeSettingTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
