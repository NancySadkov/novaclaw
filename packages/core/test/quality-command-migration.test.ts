import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Config } from "@novaclaw/core/config"
import { Database } from "@novaclaw/core/database/database"
import { Global } from "@novaclaw/core/global"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { Quality } from "@novaclaw/core/session/runner/quality"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SettingsConfigMigrate } from "@novaclaw/core/settings-config-migrate"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

/**
 * **The QE saved-command migration, exercised through the STORE.**
 *
 * `quality-provision.test.ts` owns the pure repair (the table, the destinations, idempotence, the
 * negative control). This file owns the claim that actually matters to a user — *an instance
 * carrying a pre-2026-07-30 `quality.commands.check` stops seeing the phantom fault* — and that
 * claim is about the path from a stored row to the command the runner would run. A unit test over
 * `migrateCommands` cannot make it: it never touches the store, the Config layer's synthetic
 * document, or `Quality.dueMidLoop`.
 *
 * ⚠️ The whole file is isolated by `test/preload.ts` (`NOVACLAW_DB=":memory:"` **and**
 * `NOVACLAW_HOME` at a PID-scoped throwaway) — the owner's real instance store is never opened.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node])))

/** The value an instance provisioned before the fix is carrying right now. */
const STALE_QUALITY = {
  enabled: true,
  cadence: 3,
  commands: { check: "cargo check --quiet", test: "cargo test --quiet" },
}

describe("QE saved-command migration — the settings store", () => {
  it.effect("repairs the stored row, carries the siblings through, and is a no-op the second time", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("quality", STALE_QUALITY)

      const notes = yield* SettingsConfigMigrate.migrateQualityCommands()
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain("cargo check --quiet")
      expect(notes[0]).toContain("MOVED")

      // The command survived — moved, not deleted — and every sibling setting is untouched.
      expect((yield* store.all()).quality).toEqual({
        enabled: true,
        cadence: 3,
        commands: { typecheck: "cargo check --quiet", test: "cargo test --quiet" },
      })

      // It runs on every boot. A second pass must neither rewrite the row nor re-notify.
      expect(yield* SettingsConfigMigrate.migrateQualityCommands()).toEqual([])
      expect((yield* store.all()).quality).toEqual({
        enabled: true,
        cadence: 3,
        commands: { typecheck: "cargo check --quiet", test: "cargo test --quiet" },
      })
    }),
  )

  it.effect("NEGATIVE CONTROL — an already-valid stored row is not touched and produces no notice", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      // A genuine per-file `check` with no `{file}` placeholder: `renderCommand` appends the path
      // and `ruff check "a.py"` is exactly right. A migration keyed on the missing placeholder
      // rather than on the known stale VALUES would destroy this setting.
      const valid = {
        enabled: true,
        commands: { check: "ruff check", syntax: "bun build --no-bundle {file}", typecheck: "cargo check --quiet" },
      }
      yield* store.set("quality", valid)
      expect(yield* SettingsConfigMigrate.migrateQualityCommands()).toEqual([])
      expect((yield* store.all()).quality).toEqual(valid)
    }),
  )

  it.effect("an instance with no quality settings at all is left alone", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      expect(yield* SettingsConfigMigrate.migrateQualityCommands()).toEqual([])
      expect(yield* store.isEmpty()).toBe(true)
      yield* store.set("quality", { enabled: true })
      expect(yield* SettingsConfigMigrate.migrateQualityCommands()).toEqual([])
      expect((yield* store.all()).quality).toEqual({ enabled: true })
    }),
  )
})

/**
 * ── the store-to-write path ─────────────────────────────────────────────────────────────────────
 *
 * Store row → the Config layer's synthetic document → `Quality.resolve` → `Quality.dueMidLoop` →
 * `Quality.renderCommand`. That last step is what produces the phantom fault: it appends the file
 * the agent just wrote to a command that takes no file. Measured on a real crate 2026-07-30 —
 * `cargo check --quiet` exits 0, `cargo check --quiet "src/lib.rs"` exits 1 with
 * `error: unexpected argument 'src/lib.rs' found` — so a gate that cannot pass fires on every write
 * and the model has nothing to fix.
 */
describe("QE saved-command migration — the phantom fault, end to end", () => {
  const configLayer = (directory: string, globalDirectory: string) =>
    AppNodeBuilder.build(LayerNode.group([Config.node, SettingsConfigStore.node, Database.node]), [
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
          ),
        ),
      ],
      [Global.node, Global.layerWith({ config: globalDirectory })],
    ])

  it.effect("the check step fires BEFORE the migration and is gone AFTER it", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const projectDir = path.join(tmp.path, "project")
      const globalDir = path.join(tmp.path, "global")
      yield* Effect.promise(async () => {
        await fs.mkdir(projectDir, { recursive: true })
        await fs.mkdir(globalDir, { recursive: true })
      })

      /** What the runner would run for a turn that wrote `src/lib.rs`, read live from the store. */
      const dueFor = Effect.fn("dueFor")(function* () {
        const config = yield* Config.Service
        const quality = Quality.resolve(Config.latest(yield* config.entries(), "quality"))
        return Quality.dueMidLoop(quality, Quality.initialState(), ["src/lib.rs"]).map((step) => ({
          label: step.label,
          command: step.command,
        }))
      })

      yield* Effect.gen(function* () {
        const store = yield* SettingsConfigStore.Service
        yield* store.set("quality", STALE_QUALITY)

        // ── BEFORE ──────────────────────────────────────────────────────────────────────────────
        const before = yield* dueFor()
        expect(before).toEqual([{ label: "check", command: 'cargo check --quiet "src/lib.rs"' }])

        // ── the migration ───────────────────────────────────────────────────────────────────────
        expect(yield* SettingsConfigMigrate.migrateAll()).toHaveLength(1)

        // ── AFTER ───────────────────────────────────────────────────────────────────────────────
        // No per-file step at all on this write (cadence 3, so the typecheck is not due yet) —
        // which is the point: the unfixable fault is gone rather than reworded.
        expect(yield* dueFor()).toEqual([])
        // …and the command is still provisioned, in the slot that runs it whole-project.
        const after = Quality.resolve(Config.latest(yield* (yield* Config.Service).entries(), "quality"))
        expect(after.commands).toEqual({ typecheck: "cargo check --quiet", test: "cargo test --quiet" })
        // Three writes later the typecheck fires — with NO file appended.
        const state = Quality.initialState()
        Quality.dueMidLoop(after, state, ["a.rs", "b.rs"])
        expect(Quality.dueMidLoop(after, state, ["c.rs"]).map((step) => step.command)).toEqual(["cargo check --quiet"])
      }).pipe(Effect.provide(configLayer(projectDir, globalDir)))
    }),
  )
})
