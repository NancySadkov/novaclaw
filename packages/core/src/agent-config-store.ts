export * as AgentConfigStore from "./agent-config-store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { AgentConfigTable, AgentSettingTable } from "./agent-config/sql"
import { ConfigAgent } from "./config/agent"

const DEFAULT_AGENT_KEY = "default_agent"

// Config→SQLite step 2: the instance-wide, SQLite-backed source of truth for config-file-borne agent
// definitions — replaces reading `agents.<name>` out of novaclaw.jsonc at runtime (the catalog-store
// template replicated per subsystem; see config-sqlite-plan). Global (not per-location) so every
// directory — including the shared scratch dir — resolves the same agents. jsonc becomes import/export
// only: the config-agent plugin seeds this store from an existing novaclaw.jsonc on first boot
// (transitional — removed in migration step 8), and the settings UI will write here (step 7).
// Markdown agents stay filesystem-walked (D2) and never touch this store.
export interface Interface {
  /** Every stored agent's config layers, keyed by agent name (apply in order to merge). */
  readonly agents: () => Effect.Effect<Record<string, ConfigAgent.Info[]>>
  /** Insert or replace the full ordered layer list for one agent. */
  readonly setLayers: (name: string, layers: ConfigAgent.Info[]) => Effect.Effect<void>
  /** Remove one agent's stored config. */
  readonly removeAgent: (name: string) => Effect.Effect<void>
  /** The default-agent name, if set. */
  readonly getDefault: () => Effect.Effect<string | undefined>
  /** Set the default-agent name. */
  readonly setDefault: (name: string) => Effect.Effect<void>
  /** Set the default-agent name only if none is set yet (used by the transitional jsonc seed). */
  readonly setDefaultIfEmpty: (name: string) => Effect.Effect<void>
  /** True when no agents are stored (used to gate the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/AgentConfigStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeLayers = Schema.decodeUnknownSync(Schema.Array(ConfigAgent.Info))

    const putSetting = (key: string, value: string) =>
      db
        .insert(AgentSettingTable)
        .values({ key, value })
        .onConflictDoUpdate({ target: AgentSettingTable.key, set: { value } })
        .run()
        .pipe(Effect.orDie)

    const getSetting = (key: string) =>
      db.select().from(AgentSettingTable).where(eq(AgentSettingTable.key, key)).get().pipe(Effect.orDie)

    return Service.of({
      agents: Effect.fn("AgentConfigStore.agents")(function* () {
        const rows = yield* db.select().from(AgentConfigTable).all().pipe(Effect.orDie)
        const result: Record<string, ConfigAgent.Info[]> = {}
        for (const row of rows) result[row.name] = [...decodeLayers(row.layers)]
        return result
      }),
      setLayers: Effect.fn("AgentConfigStore.setLayers")(function* (name, layers) {
        yield* db
          .insert(AgentConfigTable)
          .values({ name, layers })
          .onConflictDoUpdate({ target: AgentConfigTable.name, set: { layers } })
          .run()
          .pipe(Effect.orDie)
      }),
      removeAgent: Effect.fn("AgentConfigStore.removeAgent")(function* (name) {
        yield* db.delete(AgentConfigTable).where(eq(AgentConfigTable.name, name)).run().pipe(Effect.orDie)
      }),
      getDefault: Effect.fn("AgentConfigStore.getDefault")(function* () {
        const row = yield* getSetting(DEFAULT_AGENT_KEY)
        return row?.value
      }),
      setDefault: Effect.fn("AgentConfigStore.setDefault")(function* (name) {
        yield* putSetting(DEFAULT_AGENT_KEY, name)
      }),
      setDefaultIfEmpty: Effect.fn("AgentConfigStore.setDefaultIfEmpty")(function* (name) {
        const existing = yield* getSetting(DEFAULT_AGENT_KEY)
        if (!existing) yield* putSetting(DEFAULT_AGENT_KEY, name)
      }),
      isEmpty: Effect.fn("AgentConfigStore.isEmpty")(function* () {
        const row = yield* db.select().from(AgentConfigTable).get().pipe(Effect.orDie)
        return row === undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
