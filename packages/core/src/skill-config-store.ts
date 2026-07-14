export * as SkillConfigStore from "./skill-config-store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { SkillConfigTable } from "./skill-config/sql"

// Config→SQLite step 4: the instance-wide, SQLite-backed source of truth for config-borne skill
// DISCOVERY SOURCES (the catalog/agent/command-store template). Global so every directory —
// including the shared scratch dir — discovers the same skills. jsonc becomes import/export only:
// the config-skill plugin seeds this store from an existing novaclaw.jsonc on first boot
// (transitional — removed in migration step 8). The `skill(s)/` directory walk under config dirs
// stays filesystem-driven (D2).
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

    return Service.of({
      sources: Effect.fn("SkillConfigStore.sources")(function* () {
        const rows = yield* db.select().from(SkillConfigTable).all().pipe(Effect.orDie)
        return rows.map((row) => row.source)
      }),
      addSource: Effect.fn("SkillConfigStore.addSource")(function* (source) {
        yield* db.insert(SkillConfigTable).values({ source }).onConflictDoNothing().run().pipe(Effect.orDie)
      }),
      removeSource: Effect.fn("SkillConfigStore.removeSource")(function* (source) {
        yield* db.delete(SkillConfigTable).where(eq(SkillConfigTable.source, source)).run().pipe(Effect.orDie)
      }),
      isEmpty: Effect.fn("SkillConfigStore.isEmpty")(function* () {
        const row = yield* db.select().from(SkillConfigTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
