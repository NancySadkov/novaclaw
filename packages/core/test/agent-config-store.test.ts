import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { sql } from "drizzle-orm"
import { Effect, Logger, Schema } from "effect"
import { AgentConfigSeed } from "@novaclaw/core/agent-config-seed"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 2 gates: the store round-trips ordered agent layers, and the transitional
// jsonc seed is IDEMPOTENT — later store edits win over a re-run (jsonc is import-only).

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AgentConfigStore.node, FSUtil.node])))
const decodeAgent = Schema.decodeUnknownSync(ConfigAgent.Info)

/** Run `effect` with the loggers replaced by a collector, and hand back every WARN it emitted. */
const withWarnings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const warnings: string[] = []
    const collector = Logger.make((options: Logger.Options<unknown>) => {
      if (options.logLevel !== "Warn") return
      const parts = Array.isArray(options.message) ? options.message : [options.message]
      warnings.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "))
    })
    return effect.pipe(
      Effect.provide(Logger.layer([collector])),
      Effect.map((value) => ({ value, warnings })),
    )
  })

describe("AgentConfigStore", () => {
  it.effect("round-trips ordered layers, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      const layers = [decodeAgent({ description: "first" }), decodeAgent({ hidden: true })]
      yield* store.setLayers("reviewer", layers)
      expect(yield* store.isEmpty()).toBe(false)
      expect((yield* store.agents()).reviewer).toEqual(layers)

      // A second set REPLACES the full ordered list (no append).
      yield* store.setLayers("reviewer", [decodeAgent({ description: "second" })])
      expect((yield* store.agents()).reviewer).toEqual([decodeAgent({ description: "second" })])

      yield* store.removeAgent("reviewer")
      expect(yield* store.isEmpty()).toBe(true)
    }),
  )

  // Standing decision 3, applied to a config read: one unreadable `layers` blob used to be a
  // DEFECT (decodeUnknownSync THROWS inside the Effect.fn) that killed `agents()` — and this is a
  // global service on the location-boot path, so one bad row killed BOOT. It must now cost exactly
  // that one agent, and it must say so out loud.
  it.effect("one malformed layers row is skipped BY NAME; every other agent still loads", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      const { db } = yield* Database.Service
      yield* store.setLayers("healthy", [decodeAgent({ description: "still here" })])
      yield* store.setLayers("also-healthy", [decodeAgent({ hidden: true })])

      // Two ways a row goes bad that the typed API cannot produce: a hand edit through the
      // Registry, or an older/newer schema. Both are valid JSON, so the failure is a SCHEMA
      // failure, not a parse failure.
      yield* db
        .run(
          sql`INSERT INTO agent_config (name, layers, time_created, time_updated)
              VALUES ('not-a-list', '"nope"', 0, 0), ('bad-field', '[{"hidden":"yes"}]', 0, 0)`,
        )
        .pipe(Effect.orDie)

      const { value: agents, warnings } = yield* withWarnings(store.agents())
      // Degrades, never vanishes: the readable agents are all still there...
      expect(agents.healthy).toEqual([decodeAgent({ description: "still here" })])
      expect(agents["also-healthy"]).toEqual([decodeAgent({ hidden: true })])
      // ...and the unreadable ones are absent rather than half-decoded.
      expect(agents["not-a-list"]).toBeUndefined()
      expect(agents["bad-field"]).toBeUndefined()
      expect(Object.keys(agents).sort()).toEqual(["also-healthy", "healthy"])

      // Never silently: the skipped rows are NAMED in a warning an operator can find.
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("not-a-list")
      expect(warnings[0]).toContain("bad-field")
      expect(warnings[0]).toContain("agent_config")
      expect(warnings[0]).not.toContain("healthy:")

      // Deduped: a second read is not a second log line (config reads are hot).
      expect((yield* withWarnings(store.agents())).warnings).toEqual([])

      // And the store is otherwise untouched — a read never destroys.
      expect(yield* store.isEmpty()).toBe(false)
      const remaining = (yield* db.get(sql`SELECT count(*) AS count FROM agent_config`).pipe(Effect.orDie)) as {
        count: number
      }
      expect(remaining.count).toBe(4)
    }),
  )

  it.effect("default agent: set wins, setDefaultIfEmpty never clobbers", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      expect(yield* store.getDefault()).toBeUndefined()
      yield* store.setDefaultIfEmpty("build")
      expect(yield* store.getDefault()).toBe("build")
      yield* store.setDefaultIfEmpty("plan")
      expect(yield* store.getDefault()).toBe("build") // protected
      yield* store.setDefault("plan")
      expect(yield* store.getDefault()).toBe("plan") // explicit set wins
    }),
  )

  it.effect("jsonc seed imports agents + default once and is idempotent (store edits win)", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "config.json"),
          JSON.stringify({ agents: { reviewer: { description: "global reviewer" } } }),
        )
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({
            default_agent: "reviewer",
            agents: { reviewer: { hidden: true }, scribe: { description: "project scribe" } },
          }),
        )
      })

      yield* AgentConfigSeed.seedFromDirectory(globalDir)
      const first = yield* store.agents()
      // First document then second (specific wins on merge) — both from the config dir.
      expect(first.reviewer).toEqual([decodeAgent({ description: "global reviewer" }), decodeAgent({ hidden: true })])
      expect(first.scribe).toEqual([decodeAgent({ description: "project scribe" })])
      expect(yield* store.getDefault()).toBe("reviewer")

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.setLayers("reviewer", [decodeAgent({ description: "user edited" })])
      yield* store.setDefault("scribe")
      yield* AgentConfigSeed.seedFromDirectory(globalDir)
      expect((yield* store.agents()).reviewer).toEqual([decodeAgent({ description: "user edited" })])
      expect(yield* store.getDefault()).toBe("scribe")
    }),
  )
})
