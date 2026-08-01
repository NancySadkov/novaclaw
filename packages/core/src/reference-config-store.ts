export * as ReferenceConfigStore from "./reference-config-store"

import { Context, Effect, Layer, Schema } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { ReferenceConfigTable } from "./reference-config/sql"
import { ConfigReference } from "./config/reference"

// Config→SQLite step 4: the instance-wide, SQLite-backed source of truth for config-borne
// reference aliases. Global so every directory — including the shared scratch dir — resolves the
// same references. jsonc becomes import/export only: the config-reference plugin seeds this store
// from an existing novaclaw.jsonc on first boot (transitional — removed in migration step 8).
//
// The layered-row discipline (per-row decode, the operator-facing warning, layer order) lives in
// `config-store-factory.ts` and is shared with the catalog, agent and command stores. For an alias
// specifically, a silently dropped middle layer resolves it to a DIFFERENT target than the user
// configured — i.e. reading the wrong repository or the wrong directory.
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
    const references = ConfigStoreFactory.makeLayeredStore<ConfigReference.Entry>({
      db,
      table: ReferenceConfigTable,
      keyColumn: ReferenceConfigTable.name,
      keyName: "name",
      decode: Schema.decodeUnknownExit(Schema.Array(ConfigReference.Entry)),
      report: { kind: "reference alias", table: "reference_config" },
    })

    return Service.of({
      references: Effect.fn("ReferenceConfigStore.references")(function* () {
        return yield* references.all()
      }),
      setLayers: Effect.fn("ReferenceConfigStore.setLayers")(function* (name, layers) {
        yield* references.setLayers(name, layers)
      }),
      removeReference: Effect.fn("ReferenceConfigStore.removeReference")(function* (name) {
        yield* references.remove(name)
      }),
      isEmpty: Effect.fn("ReferenceConfigStore.isEmpty")(function* () {
        return yield* references.isEmpty()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
