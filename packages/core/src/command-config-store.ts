export * as CommandConfigStore from "./command-config-store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CommandConfigTable } from "./command-config/sql"
import { ConfigCommand } from "./config/command"

// Config→SQLite step 3: the instance-wide, SQLite-backed source of truth for config-file-borne
// command definitions (the catalog/agent-store template). Global so every directory — including the
// shared scratch dir — resolves the same commands. jsonc becomes import/export only: the
// config-command plugin seeds this store from an existing novaclaw.jsonc on first boot
// (transitional — removed in migration step 8). Markdown commands stay filesystem-walked (D2).
export interface Interface {
  /** Every stored command's config layers, keyed by command name (apply in order to merge). */
  readonly commands: () => Effect.Effect<Record<string, ConfigCommand.Info[]>>
  /** Insert or replace the full ordered layer list for one command. */
  readonly setLayers: (name: string, layers: ConfigCommand.Info[]) => Effect.Effect<void>
  /** Remove one command's stored config. */
  readonly removeCommand: (name: string) => Effect.Effect<void>
  /** True when no commands are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommandConfigStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeLayers = Schema.decodeUnknownSync(Schema.Array(ConfigCommand.Info))

    return Service.of({
      commands: Effect.fn("CommandConfigStore.commands")(function* () {
        const rows = yield* db.select().from(CommandConfigTable).all().pipe(Effect.orDie)
        const result: Record<string, ConfigCommand.Info[]> = {}
        for (const row of rows) result[row.name] = [...decodeLayers(row.layers)]
        return result
      }),
      setLayers: Effect.fn("CommandConfigStore.setLayers")(function* (name, layers) {
        yield* db
          .insert(CommandConfigTable)
          .values({ name, layers })
          .onConflictDoUpdate({ target: CommandConfigTable.name, set: { layers } })
          .run()
          .pipe(Effect.orDie)
      }),
      removeCommand: Effect.fn("CommandConfigStore.removeCommand")(function* (name) {
        yield* db.delete(CommandConfigTable).where(eq(CommandConfigTable.name, name)).run().pipe(Effect.orDie)
      }),
      isEmpty: Effect.fn("CommandConfigStore.isEmpty")(function* () {
        const row = yield* db.select().from(CommandConfigTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
