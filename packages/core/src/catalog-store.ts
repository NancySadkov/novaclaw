export * as CatalogStore from "./catalog-store"

import { Context, Effect, Layer, Schema } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
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
//
// This file used to BE the template the other three layered stores were copied from, and said so.
// The template now lives in `config-store-factory.ts`; the per-row decode discipline and the
// operator-facing warning it carries are documented there, not here.
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
    const providers = ConfigStoreFactory.makeLayeredStore<ConfigProvider.Info>({
      db,
      table: CatalogProviderTable,
      keyColumn: CatalogProviderTable.id,
      keyName: "id",
      decode: Schema.decodeUnknownExit(Schema.Array(ConfigProvider.Info)),
      report: { kind: "provider", table: "catalog_provider" },
    })
    // `catalog_setting` is one of the three byte-identical `(key, value)` tables, so the
    // default-model ref is a key/value read and not four hand-written statements.
    const settings = ConfigStoreFactory.makeKeyValueStore<string>({
      db,
      table: CatalogSettingTable,
      keyColumn: CatalogSettingTable.key,
    })

    return Service.of({
      providers: Effect.fn("CatalogStore.providers")(function* () {
        return yield* providers.all()
      }),
      setLayers: Effect.fn("CatalogStore.setLayers")(function* (id, layers) {
        yield* providers.setLayers(id, layers)
      }),
      removeProvider: Effect.fn("CatalogStore.removeProvider")(function* (id) {
        yield* providers.remove(id)
      }),
      getDefault: Effect.fn("CatalogStore.getDefault")(function* () {
        return yield* settings.get(DEFAULT_MODEL_KEY)
      }),
      setDefault: Effect.fn("CatalogStore.setDefault")(function* (ref) {
        yield* settings.set(DEFAULT_MODEL_KEY, ref)
      }),
      clearDefault: Effect.fn("CatalogStore.clearDefault")(function* () {
        yield* settings.remove(DEFAULT_MODEL_KEY)
      }),
      setDefaultIfEmpty: Effect.fn("CatalogStore.setDefaultIfEmpty")(function* (ref) {
        yield* settings.setIfAbsent(DEFAULT_MODEL_KEY, ref)
      }),
      isEmpty: Effect.fn("CatalogStore.isEmpty")(function* () {
        return yield* providers.isEmpty()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
