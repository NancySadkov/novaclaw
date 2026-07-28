export * as AgentConfigStore from "./agent-config-store"

import { eq } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Schema, SchemaIssue } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { AgentConfigTable, AgentSettingTable } from "./agent-config/sql"
import { ConfigAgent } from "./config/agent"

const DEFAULT_AGENT_KEY = "default_agent"

/**
 * Format an Effect decode failure into a short human-readable reason — the same shape
 * `settings-config-seed.ts` uses, so every "a stored config row could not be read" notice reads
 * the same way to a user. Duplicated per store on purpose: these four layered stores are
 * deliberate copies of one template (see the header comment) and share no helper module.
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
      `${fresh.length} stored agent${one ? "" : "s"} failed validation and ${one ? "is" : "are"} UNAVAILABLE — ` +
        `every other agent still loaded. Fix or delete the row (Registry app → agent_config):\n` +
        fresh.map((line) => `  - ${line}`).join("\n"),
    )
  })

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
    // PER-ROW, and never `decodeUnknownSync`. Sync decode THROWS, and this runs inside an
    // `Effect.fn` on a `makeGlobalNode` service that every location boot resolves — so one
    // malformed `layers` blob was a DEFECT that killed `agents()` outright, i.e. every agent
    // vanished and the boot died with it. Standing decision 3: a read never destroys, and an
    // unavailable subsystem NAMES itself instead of rendering empty.
    //
    // Granularity is the ROW, not the individual layer: layers merge in order and later layers
    // override earlier ones, so silently dropping one layer out of the middle yields a DIFFERENT
    // agent than the user configured (a hidden agent becomes visible, a restricted one
    // unrestricted). Quietly wrong is worse than honestly missing — so an unreadable row means
    // that ONE agent is unavailable and said so, and every other row still loads.
    const decodeLayers = Schema.decodeUnknownExit(Schema.Array(ConfigAgent.Info))
    const reported = new Set<string>()

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
        const skipped: string[] = []
        for (const row of rows) {
          const decoded = decodeLayers(row.layers)
          if (Exit.isSuccess(decoded)) {
            result[row.name] = [...decoded.value]
            continue
          }
          skipped.push(`${row.name}: ${decodeFailureReason(decoded.cause)}`)
        }
        if (skipped.length > 0) yield* warnUnreadable(reported, skipped)
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
