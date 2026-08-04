export * as CommandConfigStore from "./command-config-store"

import { Context, Effect, Layer, Schema } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CommandConfigTable } from "./command-config/sql"
import { ConfigCommand } from "./config/command"

// Config→SQLite step 3: the instance-wide, SQLite-backed source of truth for config-file-borne
// command definitions. Global so every directory — including the shared scratch dir — resolves the
// same commands. jsonc becomes import/export only: the config-command plugin seeds this store from
// an existing novaclaw.jsonc on first boot (transitional — removed in migration step 8). Markdown
// commands stay filesystem-walked (D2).
//
// The layered-row discipline (per-row decode, the operator-facing warning, layer order) lives in
// `config-store-factory.ts` and is shared with the catalog, agent and reference stores.
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
    const commands = ConfigStoreFactory.makeLayeredStore<ConfigCommand.Info>({
      db,
      table: CommandConfigTable,
      keyColumn: CommandConfigTable.name,
      keyName: "name",
      decode: Schema.decodeUnknownExit(Schema.Array(ConfigCommand.Info)),
      report: { kind: "command", table: "command_config" },
    })

    return Service.of({
      commands: Effect.fn("CommandConfigStore.commands")(function* () {
        return yield* commands.all()
      }),
      setLayers: Effect.fn("CommandConfigStore.setLayers")(function* (name, layers) {
        yield* commands.setLayers(name, layers)
      }),
      removeCommand: Effect.fn("CommandConfigStore.removeCommand")(function* (name) {
        yield* commands.remove(name)
      }),
      isEmpty: Effect.fn("CommandConfigStore.isEmpty")(function* () {
        return yield* commands.isEmpty()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
