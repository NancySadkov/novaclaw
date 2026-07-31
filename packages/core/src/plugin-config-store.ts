export * as PluginConfigStore from "./plugin-config-store"

import { Context, Effect, Layer } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { PluginConfigTable } from "./plugin-config/sql"

export type PluginConfigEntry = {
  package: string
  options?: Record<string, unknown>
}

// Config→SQLite step 5: the instance-wide, SQLite-backed source of truth for config-borne
// external plugin specs. Global so every directory — including the shared scratch dir — loads the
// same plugins. jsonc becomes import/export only: the config-plugin loader seeds this store from
// an existing novaclaw.jsonc on first boot (transitional — removed in migration step 8).
//
// A LIST store, like the skill store, but with one payload column: the package string is the
// identity and `options` is last-write-wins. It consumes `makeRowStore` directly — the row→entry
// mapping below is the only thing a list-shaped factory would have held, and it is not shared.
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
    const rows = ConfigStoreFactory.makeRowStore(db, PluginConfigTable, PluginConfigTable.package)

    return Service.of({
      plugins: Effect.fn("PluginConfigStore.plugins")(function* () {
        return (yield* rows.selectAll()).map((row) => ({
          package: row.package as string,
          ...(row.options ? { options: row.options as Record<string, unknown> } : {}),
        }))
      }),
      setPlugin: Effect.fn("PluginConfigStore.setPlugin")(function* (entry) {
        const options = entry.options ?? null
        yield* rows.upsert({ package: entry.package, options }, { options })
      }),
      removePlugin: Effect.fn("PluginConfigStore.removePlugin")(function* (pkg) {
        yield* rows.deleteOne(pkg)
      }),
      isEmpty: Effect.fn("PluginConfigStore.isEmpty")(function* () {
        return yield* rows.isEmpty()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
