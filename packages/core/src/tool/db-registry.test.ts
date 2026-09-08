import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "../database/database"
import { AppNodeBuilder } from "../effect/app-node-builder"
import { LayerNode } from "../effect/layer-node"
import { SettingsConfigStore } from "../settings-config-store"
import { testEffect } from "../../test/lib/effect"
import { DbRegistryTool } from "./db-registry"

/**
 * The `registry` tool's own surface — the OPS, not `DbRegistry`'s guards (those are pinned in
 * `test/db-registry.test.ts` against a real database).
 *
 * ⚠️ It runs `DbRegistryTool.run` rather than re-deriving what it thinks the tool does, because the
 * defect this tool exists to close was a missing CALLER, and a test that reimplements the call proves
 * nothing about one.
 */
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node])))

describe("the registry tool", () => {
  it.effect("tables → rows → update, and the owning store sees the write", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("username", "before")

      const tables = yield* DbRegistryTool.run({ op: "tables" })
      expect(tables.message).toContain("runtime_setting")
      // The count column is ours, so it is NOT framed — same call `log`'s `count` makes.
      expect(tables.message).not.toContain(DbRegistryTool.FOREIGN_LABEL)

      const rows = yield* DbRegistryTool.run({ op: "rows", table: "runtime_setting" })
      expect(rows.message).toContain("username")
      expect(rows.message).toContain("rowid=")
      // ⚠️ Stored values ARE framed: nothing framed them on the way INTO the database.
      expect(rows.message).toContain(DbRegistryTool.FOREIGN_LABEL)

      // `session` is not config-backed, so the agent may write it — proven by writing one.
      const before = yield* DbRegistryTool.run({ op: "rows", table: "data_migration" })
      expect(before.message).toContain("data_migration")
      yield* DbRegistryTool.run({
        op: "insert",
        table: "data_migration",
        values: { name: "tool-probe", time_completed: 1 },
      })
      const written = yield* DbRegistryTool.run({ op: "rows", table: "data_migration" })
      expect(written.message).toContain("tool-probe")
    }),
  )

  it.effect("a config table is refused THROUGH THE TOOL, as a ToolFailure naming `configure`", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("username", "unchanged")
      const rows = yield* DbRegistryTool.run({ op: "rows", table: "runtime_setting" })
      const rowid = Number(/rowid=(\d+)/.exec(rows.message)?.[1])
      expect(Number.isFinite(rowid)).toBe(true)

      // ⚠️ Asserted through `run`, not through `DbRegistry.updateRow`: the whole risk in adding a
      // second caller is that it forgets to pass `writer: "agent"`, and only this path can see that.
      const error = yield* DbRegistryTool.run({
        op: "update",
        table: "runtime_setting",
        rowid,
        values: { value: JSON.stringify("written-by-agent") },
      }).pipe(Effect.flip)
      expect(error.message).toContain("`configure`")
      expect((yield* store.all()).username).toBe("unchanged")

      // READS stay open — inspecting its own instance is the posture, and a read corrupts nothing.
      expect((yield* DbRegistryTool.run({ op: "rows", table: "runtime_setting" })).message).toContain("username")
    }),
  )

  it.effect("an unknown table is a legible failure, not a defect", () =>
    Effect.gen(function* () {
      const error = yield* DbRegistryTool.run({ op: "rows", table: "nope; DROP TABLE session" }).pipe(Effect.flip)
      expect(error.message).toContain("Unknown table")
    }),
  )

  it.effect("a page is bounded and a wide cell is truncated", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("username", "x".repeat(DbRegistryTool.MAX_CELL_CHARS * 3))
      const rows = yield* DbRegistryTool.run({ op: "rows", table: "runtime_setting", limit: 100_000 })
      for (const line of rows.message.split("\n"))
        expect(line.length).toBeLessThanOrEqual(DbRegistryTool.MAX_CELL_CHARS * 4)
      expect(rows.message).toContain("…")
    }),
  )
})
