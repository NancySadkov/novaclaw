import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { sql } from "drizzle-orm"
import { Effect, Logger, Schema } from "effect"
import { CommandConfigSeed } from "@novaclaw/core/command-config-seed"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigCommand } from "@novaclaw/core/config/command"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 3 gates: ordered layer round-trip + the idempotent jsonc seed.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, CommandConfigStore.node, FSUtil.node])))
const decodeCommand = Schema.decodeUnknownSync(ConfigCommand.Info)

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

describe("CommandConfigStore", () => {
  it.effect("round-trips ordered layers, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* CommandConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      const layers = [decodeCommand({ template: "first" }), decodeCommand({ template: "second", subtask: true })]
      yield* store.setLayers("review", layers)
      expect(yield* store.isEmpty()).toBe(false)
      expect((yield* store.commands()).review).toEqual(layers)

      yield* store.setLayers("review", [decodeCommand({ template: "third" })])
      expect((yield* store.commands()).review).toEqual([decodeCommand({ template: "third" })])

      yield* store.removeCommand("review")
      expect(yield* store.isEmpty()).toBe(true)
    }),
  )

  // Standing decision 3: one unreadable `layers` blob used to be a DEFECT (decodeUnknownSync
  // THROWS inside the Effect.fn) that killed `commands()` — a global service on the location-boot
  // path, so one bad row killed BOOT. It must cost exactly that one command, and say so out loud.
  it.effect("one malformed layers row is skipped BY NAME; every other command still loads", () =>
    Effect.gen(function* () {
      const store = yield* CommandConfigStore.Service
      const { db } = yield* Database.Service
      yield* store.setLayers("healthy", [decodeCommand({ template: "still here" })])

      // Valid JSON, invalid shape — what a Registry hand-edit or a schema skew actually produces.
      yield* db
        .run(
          sql`INSERT INTO command_config (name, layers, time_created, time_updated) VALUES ('broken', '"nope"', 0, 0)`,
        )
        .pipe(Effect.orDie)

      const { value: commands, warnings } = yield* withWarnings(store.commands())
      expect(commands.healthy).toEqual([decodeCommand({ template: "still here" })])
      expect(commands.broken).toBeUndefined()
      expect(Object.keys(commands)).toEqual(["healthy"])

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("broken")
      expect(warnings[0]).toContain("command_config")
      // Deduped: a second read is not a second log line (config reads are hot).
      expect((yield* withWarnings(store.commands())).warnings).toEqual([])
    }),
  )

  it.effect("jsonc seed imports command layers once and is idempotent (store edits win)", () =>
    Effect.gen(function* () {
      const store = yield* CommandConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "config.json"),
          JSON.stringify({ commands: { review: { template: "global review" } } }),
        )
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ commands: { review: { template: "project review" }, docs: { template: "write docs" } } }),
        )
      })

      yield* CommandConfigSeed.seedFromDirectory(globalDir)
      const first = yield* store.commands()
      expect(first.review).toEqual([
        decodeCommand({ template: "global review" }),
        decodeCommand({ template: "project review" }),
      ])
      expect(first.docs).toEqual([decodeCommand({ template: "write docs" })])

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.setLayers("review", [decodeCommand({ template: "user edited" })])
      yield* CommandConfigSeed.seedFromDirectory(globalDir)
      expect((yield* store.commands()).review).toEqual([decodeCommand({ template: "user edited" })])
    }),
  )
})
