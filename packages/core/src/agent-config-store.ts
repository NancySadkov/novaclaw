export * as AgentConfigStore from "./agent-config-store"

import { Context, Effect, Layer, Schema } from "effect"
import { ConfigStoreFactory } from "./config-store-factory"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { AgentConfigTable, AgentSettingTable } from "./agent-config/sql"
import { ConfigAgent } from "./config/agent"

const DEFAULT_AGENT_KEY = "default_agent"

// Config→SQLite step 2: the instance-wide, SQLite-backed source of truth for config-file-borne agent
// definitions — replaces reading `agents.<name>` out of novaclaw.jsonc at runtime. Global (not
// per-location) so every directory — including the shared scratch dir — resolves the same agents.
// jsonc becomes import/export only: the config-agent plugin seeds this store from an existing
// novaclaw.jsonc on first boot (transitional — removed in migration step 8), and the settings UI will
// write here (step 7). Markdown agents stay filesystem-walked (D2) and never touch this store.
//
// The layered-row discipline (per-row decode, the operator-facing warning, layer order) lives in
// `config-store-factory.ts` and is shared with the catalog, command and reference stores.
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
  /**
   * Remove the stored default-agent name (pruning a dangling ref after an agent delete).
   *
   * Added 2026-07-28 alongside `agent.remove`, mirroring `CatalogStore.clearDefault`. It exists
   * because `default_agent` was WRITE-ONLY through the config surface: `PATCH /config` routes it
   * via `mergePatch`, which has no null-deletion (`merge-patch.ts`), and `Config.Info.default_agent`
   * is a plain optional string — so a ref could be set and then never unset by any agent repairing
   * its own instance. Deletes the ROW, not the value: an empty-string default would still be a
   * value and would block `setDefaultIfEmpty` from ever seeding again.
   */
  readonly clearDefault: () => Effect.Effect<void>
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
    const agents = ConfigStoreFactory.makeLayeredStore<ConfigAgent.Info>({
      db,
      table: AgentConfigTable,
      keyColumn: AgentConfigTable.name,
      keyName: "name",
      decode: Schema.decodeUnknownExit(Schema.Array(ConfigAgent.Info)),
      report: { kind: "agent", table: "agent_config" },
    })
    const settings = ConfigStoreFactory.makeKeyValueStore<string>({
      db,
      table: AgentSettingTable,
      keyColumn: AgentSettingTable.key,
    })

    return Service.of({
      agents: Effect.fn("AgentConfigStore.agents")(function* () {
        return yield* agents.all()
      }),
      setLayers: Effect.fn("AgentConfigStore.setLayers")(function* (name, layers) {
        yield* agents.setLayers(name, layers)
      }),
      removeAgent: Effect.fn("AgentConfigStore.removeAgent")(function* (name) {
        yield* agents.remove(name)
      }),
      getDefault: Effect.fn("AgentConfigStore.getDefault")(function* () {
        return yield* settings.get(DEFAULT_AGENT_KEY)
      }),
      setDefault: Effect.fn("AgentConfigStore.setDefault")(function* (name) {
        yield* settings.set(DEFAULT_AGENT_KEY, name)
      }),
      clearDefault: Effect.fn("AgentConfigStore.clearDefault")(function* () {
        yield* settings.remove(DEFAULT_AGENT_KEY)
      }),
      setDefaultIfEmpty: Effect.fn("AgentConfigStore.setDefaultIfEmpty")(function* (name) {
        yield* settings.setIfAbsent(DEFAULT_AGENT_KEY, name)
      }),
      isEmpty: Effect.fn("AgentConfigStore.isEmpty")(function* () {
        return yield* agents.isEmpty()
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
