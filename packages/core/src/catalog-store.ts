export * as CatalogStore from "./catalog-store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CatalogProviderTable, CatalogSettingTable } from "./catalog/sql"
import { ConfigProvider } from "./config/provider"
import type { ProviderV2 } from "./provider"

const DEFAULT_MODEL_KEY = "default_model"

// The instance-wide, SQLite-backed source of truth for providers/models — replaces reading
// novaclaw.jsonc at runtime (settings-in-sqlite migration). Global (not per-location) so every agent,
// in any directory (incl. the shared scratch dir), sees the same catalog. jsonc becomes import/export
// only: the config-provider plugin seeds this store from an existing novaclaw.jsonc on boot (transitional
// — removed in migration step 8), and the settings UI will write here instead of patching jsonc.
export interface Interface {
  /** Every stored provider's config layers, keyed by provider id (apply in order to merge). */
  readonly providers: () => Effect.Effect<Record<string, ConfigProvider.Info[]>>
  /** Insert or replace the full ordered layer list for one provider. */
  readonly setLayers: (id: ProviderV2.ID, layers: ConfigProvider.Info[]) => Effect.Effect<void>
  /** Remove one provider. */
  readonly removeProvider: (id: ProviderV2.ID) => Effect.Effect<void>
  /** The default-model ref (`providerID/modelID`), if set. */
  readonly getDefault: () => Effect.Effect<string | undefined>
  /** Set the default-model ref. */
  readonly setDefault: (ref: string) => Effect.Effect<void>
  /** Remove the stored default-model ref (T10iv: pruning a dangling ref after a provider delete). */
  readonly clearDefault: () => Effect.Effect<void>
  /** Set the default-model ref only if none is set yet (used by the transitional jsonc seed). */
  readonly setDefaultIfEmpty: (ref: string) => Effect.Effect<void>
  /** True when no providers are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CatalogStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeLayers = Schema.decodeUnknownSync(Schema.Array(ConfigProvider.Info))

    const putSetting = (key: string, value: string) =>
      db
        .insert(CatalogSettingTable)
        .values({ key, value })
        .onConflictDoUpdate({ target: CatalogSettingTable.key, set: { value } })
        .run()
        .pipe(Effect.orDie)

    const getSetting = (key: string) =>
      db.select().from(CatalogSettingTable).where(eq(CatalogSettingTable.key, key)).get().pipe(Effect.orDie)

    return Service.of({
      providers: Effect.fn("CatalogStore.providers")(function* () {
        const rows = yield* db.select().from(CatalogProviderTable).all().pipe(Effect.orDie)
        const result: Record<string, ConfigProvider.Info[]> = {}
        for (const row of rows) result[row.id] = [...decodeLayers(row.layers)]
        return result
      }),
      setLayers: Effect.fn("CatalogStore.setLayers")(function* (id, layers) {
        yield* db
          .insert(CatalogProviderTable)
          .values({ id, layers })
          .onConflictDoUpdate({ target: CatalogProviderTable.id, set: { layers } })
          .run()
          .pipe(Effect.orDie)
      }),
      removeProvider: Effect.fn("CatalogStore.removeProvider")(function* (id) {
        yield* db.delete(CatalogProviderTable).where(eq(CatalogProviderTable.id, id)).run().pipe(Effect.orDie)
      }),
      getDefault: Effect.fn("CatalogStore.getDefault")(function* () {
        const row = yield* getSetting(DEFAULT_MODEL_KEY)
        return row?.value
      }),
      setDefault: Effect.fn("CatalogStore.setDefault")(function* (ref) {
        yield* putSetting(DEFAULT_MODEL_KEY, ref)
      }),
      clearDefault: Effect.fn("CatalogStore.clearDefault")(function* () {
        yield* db.delete(CatalogSettingTable).where(eq(CatalogSettingTable.key, DEFAULT_MODEL_KEY)).run().pipe(Effect.orDie)
      }),
      setDefaultIfEmpty: Effect.fn("CatalogStore.setDefaultIfEmpty")(function* (ref) {
        const existing = yield* getSetting(DEFAULT_MODEL_KEY)
        if (!existing) yield* putSetting(DEFAULT_MODEL_KEY, ref)
      }),
      isEmpty: Effect.fn("CatalogStore.isEmpty")(function* () {
        const row = yield* db.select().from(CatalogProviderTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
