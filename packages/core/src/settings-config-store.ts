export * as SettingsConfigStore from "./settings-config-store"

import { Context, Effect, Layer } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { RuntimeSettingTable } from "./settings-config/sql"

// Config→SQLite step 6: the instance-wide, SQLite-backed source of truth for runtime settings.
// Global so every directory — including the shared scratch dir — resolves the same settings.
// Readers stay untouched: the Config layer appends ONE synthetic document holding these values to
// `entries()`, so every `Config.latest(entries, key)` reader picks them up (findLast = most
// specific wins). jsonc becomes import/export only: the Config layer seeds this store from the
// location's config documents on first boot (transitional — removed in migration step 8).
//
// `runtime_setting` is one of the three byte-identical `(key text primary key, value text json)`
// tables — the other two are `catalog_setting` and `agent_setting`, which back the default-model
// and default-agent refs. All three are served by `ConfigStoreFactory.makeKeyValueStore`. ⚠️ That
// is the TYPESCRIPT collapse only: the three tables are still three tables, because merging them
// physically is a schema change and needs a migration.
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
    const settings = ConfigStoreFactory.makeKeyValueStore({
      db,
      table: RuntimeSettingTable,
      keyColumn: RuntimeSettingTable.key,
    })

    return Service.of({
      all: Effect.fn("SettingsConfigStore.all")(function* () {
        return yield* settings.all()
      }),
      set: Effect.fn("SettingsConfigStore.set")(function* (key, value) {
        yield* settings.set(key, value)
      }),
      remove: Effect.fn("SettingsConfigStore.remove")(function* (key) {
        yield* settings.remove(key)
      }),
      isEmpty: Effect.fn("SettingsConfigStore.isEmpty")(function* () {
        return yield* settings.isEmpty()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
