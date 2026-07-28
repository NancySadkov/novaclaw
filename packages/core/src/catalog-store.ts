export * as CatalogStore from "./catalog-store"

import { eq } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Schema, SchemaIssue } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CatalogProviderTable, CatalogSettingTable } from "./catalog/sql"
import { ConfigProvider } from "./config/provider"
import type { ProviderV2 } from "./provider"

const DEFAULT_MODEL_KEY = "default_model"

/**
 * Format an Effect decode failure into a short human-readable reason — the same shape
 * `settings-config-seed.ts` uses, so every "a stored config row could not be read" notice reads
 * the same way to a user. Duplicated per store on purpose: the four layered stores are deliberate
 * copies of one template (this file is that template) and share no helper module.
 */
function decodeFailureReason(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  if (Schema.isSchemaError(error)) {
    const messages = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => issue.message)
    if (messages.length > 0) return messages.join("; ")
  }
  return String(error)
}

/**
 * The trace an operator can find: a WARN in the instance log (Developer mode → Debug app → error
 * log), naming every row that was dropped and why — the same reporting `config.ts` does for an
 * unreadable settings row. Deduped against `reported` for the life of the layer so a caller that
 * reads per-turn cannot turn one corrupt row into a log flood.
 */
const warnUnreadable = (reported: Set<string>, skipped: readonly string[]) =>
  Effect.suspend(() => {
    const fresh = skipped.filter((line) => !reported.has(line))
    if (fresh.length === 0) return Effect.void
    for (const line of fresh) reported.add(line)
    const one = fresh.length === 1
    return Effect.logWarning(
      `${fresh.length} stored provider${one ? "" : "s"} failed validation and ${one ? "is" : "are"} UNAVAILABLE — ` +
        `every other provider still loaded. Fix or delete the row (Registry app → catalog_provider):\n` +
        fresh.map((line) => `  - ${line}`).join("\n"),
    )
  })

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
    // PER-ROW, and never `decodeUnknownSync`. Sync decode THROWS, and this runs inside an
    // `Effect.fn` on a `makeGlobalNode` service that every location boot resolves — so one
    // malformed `layers` blob was a DEFECT that killed `providers()` outright: the whole catalog
    // vanished and the boot died with it. Standing decision 3: a read never destroys, and an
    // unavailable subsystem NAMES itself instead of rendering empty. (Rendering empty is
    // especially treacherous here — a zero-provider catalog is a SUPPORTED first-run state, so a
    // silent total loss would be indistinguishable from a fresh install and route the user to
    // "Add models" instead of telling them their catalog is broken.)
    //
    // Granularity is the ROW, not the individual layer: layers merge in order and later layers
    // override earlier ones, so silently dropping one layer out of the middle yields a DIFFERENT
    // provider than the user configured (a corrected baseURL or apiKey reverts to the stale one).
    // Quietly wrong is worse than honestly missing — so an unreadable row means that ONE provider
    // is unavailable and said so, and every other row still loads.
    const decodeLayers = Schema.decodeUnknownExit(Schema.Array(ConfigProvider.Info))
    const reported = new Set<string>()

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
        const skipped: string[] = []
        for (const row of rows) {
          const decoded = decodeLayers(row.layers)
          if (Exit.isSuccess(decoded)) {
            result[row.id] = [...decoded.value]
            continue
          }
          skipped.push(`${row.id}: ${decodeFailureReason(decoded.cause)}`)
        }
        if (skipped.length > 0) yield* warnUnreadable(reported, skipped)
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
