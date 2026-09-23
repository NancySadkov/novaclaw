import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Quality } from "@novaclaw/core/session/runner/quality"
import { SettingsConfigMigrate } from "@novaclaw/core/settings-config-migrate"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AgentConfigStore.node])))

describe("officer quality command repair", () => {
  it.effect("moves stale commands in each officer record and preserves unrelated settings", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      yield* store.setLayers("nova", [{ qualityConfig: {
        enabled: true,
        cadence: 3,
        commands: { check: "cargo check --quiet", test: "cargo test --quiet" },
      } } as never])
      yield* store.setLayers("other", [{ qualityConfig: {
        enabled: true,
        commands: { check: "ruff check" },
      } } as never])

      const before = Quality.resolve((yield* store.agents()).nova?.[0]?.qualityConfig)
      expect(Quality.dueMidLoop(before, Quality.initialState(), ["src/lib.rs"]).map((step) => step.command))
        .toEqual(['cargo check --quiet "src/lib.rs"'])

      const notes = yield* SettingsConfigMigrate.migrateQualityCommands()
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain("nova:")
      const records = yield* store.agents()
      expect(records.nova?.[0]?.qualityConfig).toEqual({
        enabled: true,
        cadence: 3,
        commands: { typecheck: "cargo check --quiet", test: "cargo test --quiet" },
      })
      expect(records.other?.[0]?.qualityConfig?.commands).toEqual({ check: "ruff check" })
      const after = Quality.resolve(records.nova?.[0]?.qualityConfig)
      expect(Quality.dueMidLoop(after, Quality.initialState(), ["src/lib.rs"])).toEqual([])
      expect(yield* SettingsConfigMigrate.migrateQualityCommands()).toEqual([])
    }),
  )
})
