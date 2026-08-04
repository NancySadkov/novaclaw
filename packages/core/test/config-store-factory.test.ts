import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Logger, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { ConfigCommand } from "@novaclaw/core/config/command"
import { ConfigProvider } from "@novaclaw/core/config/provider"
import { ConfigStoreFactory } from "@novaclaw/core/config-store-factory"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { testEffect } from "./lib/effect"

/**
 * **The seven config stores share three factories, so their shared invariants are pinned ONCE.**
 *
 * v0.2.0-prep Wave 4 item 10 collapsed `{catalog,agent-config,command-config,reference-config,
 * skill-config,plugin-config,settings-config}-store.ts` onto `config-store-factory.ts`. The line
 * count was the smaller half of the point; this file is the larger one (ruling 1). Before the
 * collapse each store carried its own copy of the per-row decode, its own `warnUnreadable`, and its
 * own four Drizzle statements — so every property below was either asserted four times or, more
 * often, asserted for ONE store and merely believed of the other three.
 *
 * ⚠️ The per-store suites are NOT redundant with this file and neither replaces the other. They
 * assert each store's own nouns, seeds and wire shapes; this asserts the properties the factory is
 * responsible for, ACROSS every store that uses it — which is the only way "all four layered stores
 * behave the same" stops being a claim about files other than the one it is written in.
 *
 * The negative control that makes this real: break one shared property inside
 * `config-store-factory.ts` and every case below fails at once, together with the per-store suites.
 * Verified 2026-07-31 (see the commit message / the agent report for what was reverted).
 */

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentConfigStore.node,
      CatalogStore.node,
      CommandConfigStore.node,
      PluginConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
      SkillConfigStore.node,
    ]),
  ),
)

/** Run `effect` with the loggers replaced by a collector, and hand back every WARN record it emitted. */
const withWarningRecords = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const records: unknown[][] = []
    const collector = Logger.make((options: Logger.Options<unknown>) => {
      if (options.logLevel !== "Warn") return
      records.push(Array.isArray(options.message) ? [...options.message] : [options.message])
    })
    return effect.pipe(
      Effect.provide(Logger.layer([collector])),
      Effect.map((value) => ({ value, records })),
    )
  })

const decodeProvider = Schema.decodeUnknownSync(ConfigProvider.Info)
const decodeAgent = Schema.decodeUnknownSync(ConfigAgent.Info)
const decodeCommand = Schema.decodeUnknownSync(ConfigCommand.Info)

// ─── the layered stores ──────────────────────────────────────────────────────────────────────────

interface LayeredCase {
  readonly label: string
  /** The SQLite table, which the operator-facing warning must name. */
  readonly table: string
  /** Its primary-key column — `id` for the catalog, `name` for the other three. */
  readonly keyColumn: string
  readonly read: () => Effect.Effect<Record<string, readonly unknown[]>>
  readonly set: (name: string, layers: readonly unknown[]) => Effect.Effect<void>
  readonly remove: (name: string) => Effect.Effect<void>
  readonly isEmpty: () => Effect.Effect<boolean>
  /** Two DISTINCT decodable layers, so "order preserved" is distinguishable from "set membership". */
  readonly layers: readonly [unknown, unknown]
  /** A `layers` blob that is valid JSON but not a list at all. */
  readonly notAList: string
  /** A `layers` blob whose FIRST entry decodes and whose SECOND does not. */
  readonly mixed: string
  /** The bounded entity kind carried by the warning record. */
  readonly kind: string
}

const layeredCases = Effect.gen(function* () {
  const catalog = yield* CatalogStore.Service
  const agents = yield* AgentConfigStore.Service
  const commands = yield* CommandConfigStore.Service
  const references = yield* ReferenceConfigStore.Service
  const cases: LayeredCase[] = [
    {
      label: "CatalogStore",
      table: "catalog_provider",
      keyColumn: "id",
      read: () => catalog.providers(),
      set: (name, layers) => catalog.setLayers(ProviderV2.ID.make(name), layers as ConfigProvider.Info[]),
      remove: (name) => catalog.removeProvider(ProviderV2.ID.make(name)),
      isEmpty: () => catalog.isEmpty(),
      layers: [decodeProvider({ name: "First" }), decodeProvider({ name: "Second" })],
      notAList: '"nope"',
      mixed: '[{"name":"Fine"},123]',
      kind: "provider",
    },
    {
      label: "AgentConfigStore",
      table: "agent_config",
      keyColumn: "name",
      read: () => agents.agents(),
      set: (name, layers) => agents.setLayers(name, layers as ConfigAgent.Info[]),
      remove: (name) => agents.removeAgent(name),
      isEmpty: () => agents.isEmpty(),
      layers: [decodeAgent({ description: "first" }), decodeAgent({ hidden: true })],
      notAList: '"nope"',
      mixed: '[{"description":"fine"},123]',
      kind: "agent",
    },
    {
      label: "CommandConfigStore",
      table: "command_config",
      keyColumn: "name",
      read: () => commands.commands(),
      set: (name, layers) => commands.setLayers(name, layers as ConfigCommand.Info[]),
      remove: (name) => commands.removeCommand(name),
      isEmpty: () => commands.isEmpty(),
      layers: [decodeCommand({ template: "first" }), decodeCommand({ template: "second", subtask: true })],
      notAList: '"nope"',
      mixed: '[{"template":"fine"},123]',
      kind: "command",
    },
    {
      label: "ReferenceConfigStore",
      table: "reference_config",
      keyColumn: "name",
      read: () => references.references(),
      set: (name, layers) => references.setLayers(name, layers as string[]),
      remove: (name) => references.removeReference(name),
      isEmpty: () => references.isEmpty(),
      layers: ["https://example.test/first.git", "https://example.test/second.git"],
      notAList: '"nope"',
      mixed: '["https://example.test/fine.git",123]',
      kind: "reference alias",
    },
  ]
  return cases
})

describe("every layered store (one factory, four stores)", () => {
  it.effect("batches multiple unreadable rows into one counted, local-only record", () =>
    Effect.gen(function* () {
      const reported = new Set<string>()
      const { records } = yield* withWarningRecords(
        ConfigStoreFactory.warnUnreadable(reported, ["alpha: invalid", "beta: missing key"], {
          kind: "agent",
          table: "agent_config",
        }),
      )

      expect(records).toEqual([
        [
          { event: "config.store.read.degraded" },
          "stored config rows failed validation and are unavailable; every other row still loaded. Fix or delete the named rows in the Registry app.",
          {
            "config.kind": "agent",
            "config.table": "agent_config",
            "config.invalid": 2,
            "config.rows": "  - alpha: invalid\n  - beta: missing key",
          },
        ],
      ])
    }),
  )

  it.effect("round-trips layers IN ORDER, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      for (const store of yield* layeredCases) {
        expect(yield* store.isEmpty(), `${store.label} did not start empty`).toBe(true)

        yield* store.set("alpha", store.layers)
        expect(yield* store.isEmpty(), store.label).toBe(false)
        // ORDER, not set membership: layers merge left-to-right with later ones overriding, so a
        // store that returned them reversed would resolve to a different entity than configured.
        expect((yield* store.read())["alpha"], store.label).toEqual([...store.layers])
        expect((yield* store.read())["alpha"], store.label).not.toEqual([store.layers[1], store.layers[0]])

        // A second set REPLACES the whole ordered list — it never appends.
        yield* store.set("alpha", [store.layers[1]])
        expect((yield* store.read())["alpha"], store.label).toEqual([store.layers[1]])

        yield* store.remove("alpha")
        expect(yield* store.isEmpty(), store.label).toBe(true)
      }
    }),
  )

  // Ruling 2 / standing decision 3, for all four at once. One unreadable `layers` blob used to be a
  // DEFECT that killed the whole read — and these are global services every location boot resolves,
  // so one bad row killed BOOT.
  it.effect("an unreadable row costs exactly that row, and is NAMED with its table", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const store of yield* layeredCases) {
        yield* store.set("healthy", [store.layers[0]])
        yield* db
          .run(
            sql`INSERT INTO ${sql.identifier(store.table)} (${sql.identifier(store.keyColumn)}, layers, time_created, time_updated)
                VALUES ('broken', ${store.notAList}, 0, 0)`,
          )
          .pipe(Effect.orDie)

        const { value, records } = yield* withWarningRecords(store.read())
        // Degrades, never vanishes.
        expect(Object.keys(value).sort(), store.label).toEqual(["healthy"])
        expect(value["healthy"], store.label).toEqual([store.layers[0]])

        // Never silently: the row is named, the table an operator opens is named, and the notice
        // says what survived.
        expect(records, store.label).toHaveLength(1)
        expect(records[0], store.label).toEqual([
          { event: "config.store.read.degraded" },
          "stored config rows failed validation and are unavailable; every other row still loaded. Fix or delete the named rows in the Registry app.",
          {
            "config.kind": store.kind,
            "config.table": store.table,
            "config.invalid": 1,
            "config.rows": expect.stringContaining("broken:"),
          },
        ])
        expect(JSON.stringify(records[0]), store.label).not.toContain("healthy:")

        // Deduped: a second read is not a second log line (config reads are hot).
        expect((yield* withWarningRecords(store.read())).records, store.label).toEqual([])

        // A read never DESTROYS — both rows are still there afterwards.
        const remaining = (yield* db
          .get(sql`SELECT count(*) AS count FROM ${sql.identifier(store.table)}`)
          .pipe(Effect.orDie)) as { count: number }
        expect(remaining.count, store.label).toBe(2)
      }
    }),
  )

  // ⚠️ THE INVARIANT THAT COST A REAL FIX, and the one a factory is most likely to erode: the
  // granularity is the ROW, never the individual layer. A row whose first layer decodes and whose
  // second does not must be dropped WHOLE — half of a layer stack is a DIFFERENT entity than the
  // user configured (a corrected baseURL reverts to the stale one, a restricted agent becomes
  // unrestricted), and quietly wrong is worse than honestly missing.
  it.effect("a partly-readable row is dropped WHOLE — never half-decoded", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const store of yield* layeredCases) {
        yield* db
          .run(
            sql`INSERT INTO ${sql.identifier(store.table)} (${sql.identifier(store.keyColumn)}, layers, time_created, time_updated)
                VALUES ('partly', ${store.mixed}, 0, 0)`,
          )
          .pipe(Effect.orDie)

        const { value, records } = yield* withWarningRecords(store.read())
        expect(value["partly"], store.label).toBeUndefined()
        // Spelled out, because "undefined" alone would also pass if the store returned the good
        // layer under some other key: the entity is ABSENT, and the surviving layer is nowhere.
        expect(JSON.stringify(value), `${store.label} leaked the readable layer of a broken row`).not.toContain("fine")
        expect(records, store.label).toHaveLength(1)
        expect(records[0], store.label).toEqual([
          { event: "config.store.read.degraded" },
          "stored config rows failed validation and are unavailable; every other row still loaded. Fix or delete the named rows in the Registry app.",
          {
            "config.kind": store.kind,
            "config.table": store.table,
            "config.invalid": 1,
            "config.rows": expect.stringContaining("partly:"),
          },
        ])
      }
    }),
  )
})

// ─── the key/value stores ────────────────────────────────────────────────────────────────────────

interface DefaultRefCase {
  readonly label: string
  readonly get: () => Effect.Effect<string | undefined>
  readonly set: (value: string) => Effect.Effect<void>
  readonly setIfEmpty: (value: string) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
}

const defaultRefCases = Effect.gen(function* () {
  const catalog = yield* CatalogStore.Service
  const agents = yield* AgentConfigStore.Service
  const cases: DefaultRefCase[] = [
    {
      label: "CatalogStore default_model (catalog_setting)",
      get: () => catalog.getDefault(),
      set: (value) => catalog.setDefault(value),
      setIfEmpty: (value) => catalog.setDefaultIfEmpty(value),
      clear: () => catalog.clearDefault(),
    },
    {
      label: "AgentConfigStore default_agent (agent_setting)",
      get: () => agents.getDefault(),
      set: (value) => agents.setDefault(value),
      setIfEmpty: (value) => agents.setDefaultIfEmpty(value),
      clear: () => agents.clearDefault(),
    },
  ]
  return cases
})

describe("every key/value store (one factory, three tables)", () => {
  // `catalog_setting`, `agent_setting` and `runtime_setting` are three byte-identical
  // `(key text primary key, value text json)` tables. The factory is what makes them one BEHAVIOUR;
  // merging them into one physical table is a separate change that needs a migration.
  it.effect("the singleton default refs: explicit set wins, setIfEmpty never clobbers", () =>
    Effect.gen(function* () {
      for (const store of yield* defaultRefCases) {
        expect(yield* store.get(), store.label).toBeUndefined()
        yield* store.setIfEmpty("first")
        expect(yield* store.get(), store.label).toBe("first")
        yield* store.setIfEmpty("second")
        expect(yield* store.get(), `${store.label}: the transitional seed clobbered a user value`).toBe("first")
        yield* store.set("second")
        expect(yield* store.get(), store.label).toBe("second")
      }
    }),
  )

  // The reason `clearDefault` deletes the ROW rather than blanking the value, pinned rather than
  // commented: an empty-string default would still BE a value and would block the store's own
  // `setDefaultIfEmpty` from ever seeding again.
  it.effect("clear deletes the ROW, so setIfEmpty seeds again — and a stored '' blocks it, by design", () =>
    Effect.gen(function* () {
      for (const store of yield* defaultRefCases) {
        yield* store.set("doomed")
        yield* store.clear()
        expect(yield* store.get(), store.label).toBeUndefined()
        yield* store.setIfEmpty("reseeded")
        expect(yield* store.get(), `${store.label}: clear left a row behind`).toBe("reseeded")

        // The other half of the same distinction: absence is the ROW being gone, NOT the value
        // being falsy. A user who deliberately stored "" keeps it.
        yield* store.set("")
        yield* store.setIfEmpty("would-clobber")
        expect(yield* store.get(), `${store.label}: treated a falsy VALUE as an absent ROW`).toBe("")
      }
    }),
  )

  it.effect("the settings store is the same factory: set replaces, remove deletes the row", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      expect(yield* settings.isEmpty()).toBe(true)
      yield* settings.set("username", "first")
      yield* settings.set("snapshots", false)
      expect(yield* settings.all()).toEqual({ username: "first", snapshots: false })
      // Whole-value replace, not a merge — `latest()` semantics, no layers.
      yield* settings.set("username", "second")
      expect((yield* settings.all()).username).toBe("second")
      yield* settings.remove("username")
      yield* settings.remove("snapshots")
      expect(yield* settings.all()).toEqual({})
      expect(yield* settings.isEmpty()).toBe(true)
    }),
  )
})

// ─── the list stores ─────────────────────────────────────────────────────────────────────────────

interface ListCase {
  readonly label: string
  readonly keys: () => Effect.Effect<string[]>
  readonly put: (key: string) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly isEmpty: () => Effect.Effect<boolean>
}

const listCases = Effect.gen(function* () {
  const skills = yield* SkillConfigStore.Service
  const plugins = yield* PluginConfigStore.Service
  const cases: ListCase[] = [
    {
      label: "SkillConfigStore",
      keys: () => skills.sources(),
      put: (key) => skills.addSource(key),
      remove: (key) => skills.removeSource(key),
      isEmpty: () => skills.isEmpty(),
    },
    {
      label: "PluginConfigStore",
      keys: () => plugins.plugins().pipe(Effect.map((entries) => entries.map((entry) => entry.package))),
      put: (key) => plugins.setPlugin({ package: key }),
      remove: (key) => plugins.removePlugin(key),
      isEmpty: () => plugins.isEmpty(),
    },
  ]
  return cases
})

describe("every list store (one row skeleton, two stores)", () => {
  it.effect("keeps INSERTION order, and re-putting an existing key does not reorder it", () =>
    Effect.gen(function* () {
      for (const store of yield* listCases) {
        expect(yield* store.isEmpty(), store.label).toBe(true)
        for (const key of ["/a", "/b", "/c"]) yield* store.put(key)
        expect(yield* store.keys(), store.label).toEqual(["/a", "/b", "/c"])

        // The identity IS the key: a second write updates in place. `selectAll` has no ORDER BY, so
        // this is the rowid order the plugin store's documented "insertion order" contract rests on
        // — a store that deleted-and-reinserted on conflict would move "/a" to the end here.
        yield* store.put("/a")
        expect(yield* store.keys(), `${store.label} reordered on re-put`).toEqual(["/a", "/b", "/c"])

        yield* store.remove("/b")
        expect(yield* store.keys(), store.label).toEqual(["/a", "/c"])
        for (const key of ["/a", "/c"]) yield* store.remove(key)
        expect(yield* store.isEmpty(), store.label).toBe(true)
      }
    }),
  )

  // The plugin store is the list shape WITH a payload column, and its options are last-write-wins
  // while the row's position is not.
  it.effect("the plugin payload is last-write-wins, and options are omitted rather than null", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginConfigStore.Service
      yield* plugins.setPlugin({ package: "team@1.0.0", options: { mode: "a" } })
      yield* plugins.setPlugin({ package: "/opt/local.js" })
      yield* plugins.setPlugin({ package: "team@1.0.0", options: { mode: "b" } })
      const entries = yield* plugins.plugins()
      expect(entries).toEqual([{ package: "team@1.0.0", options: { mode: "b" } }, { package: "/opt/local.js" }])
      // An absent payload is an ABSENT key, not `options: null` — the export document round-trips
      // through `plugins.map((entry) => (entry.options ? entry : entry.package))`.
      expect(Object.keys(entries[1]!)).toEqual(["package"])
    }),
  )
})
