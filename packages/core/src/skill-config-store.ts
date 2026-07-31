export * as SkillConfigStore from "./skill-config-store"

import { Context, Effect, Layer } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { SkillConfigTable } from "./skill-config/sql"

// Config→SQLite step 4: the instance-wide, SQLite-backed source of truth for config-borne skill
// DISCOVERY SOURCES. Global so every directory — including the shared scratch dir — discovers the
// same skills. jsonc becomes import/export only: the config-skill plugin seeds this store from an
// existing novaclaw.jsonc on first boot (transitional — removed in migration step 8). The
// `skill(s)/` directory walk under config dirs stays filesystem-driven (D2).
//
// A LIST store: the row IS its own identity, so there is no payload to decode and nothing to warn
// about. It consumes `makeRowStore` directly rather than a list-shaped factory — the only thing a
// third mould would hold is the row→entry mapping below, which differs in every list store.
export interface Interface {
  /** Every stored discovery source (a URL or an absolute directory path), in insertion order. */
  readonly sources: () => Effect.Effect<string[]>
  /** Insert one source (idempotent — the source string is the identity). */
  readonly addSource: (source: string) => Effect.Effect<void>
  /** Remove one stored source. */
  readonly removeSource: (source: string) => Effect.Effect<void>
  /** True when no sources are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SkillConfigStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = ConfigStoreFactory.makeRowStore(db, SkillConfigTable, SkillConfigTable.source)

    return Service.of({
      sources: Effect.fn("SkillConfigStore.sources")(function* () {
        return (yield* rows.selectAll()).map((row) => row.source as string)
      }),
      addSource: Effect.fn("SkillConfigStore.addSource")(function* (source) {
        // No `set`: the row's identity IS its content, so a conflict is a no-op (dedup by string).
        yield* rows.upsert({ source })
      }),
      removeSource: Effect.fn("SkillConfigStore.removeSource")(function* (source) {
        yield* rows.deleteOne(source)
      }),
      isEmpty: Effect.fn("SkillConfigStore.isEmpty")(function* () {
        return yield* rows.isEmpty()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
