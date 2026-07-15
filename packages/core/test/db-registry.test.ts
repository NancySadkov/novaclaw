import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { DbRegistry } from "@novaclaw/core/db-registry"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { testEffect } from "./lib/effect"

// The Registry app's backend (Regedit over the instance SQLite): browse tables, page rows,
// edit + delete by rowid — with identifier validation so table/column names can't inject.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node])))

describe("DbRegistry", () => {
  it.effect("lists tables with row counts and rejects unknown tables", () =>
    Effect.gen(function* () {
      const all = yield* DbRegistry.tables()
      const names = all.map((table) => table.name)
      expect(names).toContain("runtime_setting")
      expect(names).toContain("session")
      expect(names.some((name) => name.startsWith("sqlite_"))).toBe(false)

      const error = yield* DbRegistry.rows({ table: "nope; DROP TABLE session" }).pipe(Effect.flip)
      expect(error._tag).toBe("DbRegistry.RegistryError")
    }),
  )

  it.effect("pages rows and edits + deletes by rowid, visible to the owning store", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      yield* store.set("shell", "bash")
      yield* store.set("username", "before-edit")

      const page = yield* DbRegistry.rows({ table: "runtime_setting", limit: 10 })
      expect(page.rowCount).toBe(2)
      expect(page.columns).toContain("key")
      expect(page.columns).toContain("value")
      const usernameRow = page.rows.find((row) => row.values.key === "username")!
      expect(usernameRow).toBeDefined()
      // Raw registry view: JSON columns surface as their stored TEXT ("\"before-edit\"").
      expect(String(usernameRow.values.value)).toContain("before-edit")

      yield* DbRegistry.updateRow({
        table: "runtime_setting",
        rowid: usernameRow.rowid,
        values: { value: JSON.stringify("after-edit"), ignored_column: "dropped" },
      })
      expect((yield* store.all()).username).toBe("after-edit")

      yield* DbRegistry.deleteRow({ table: "runtime_setting", rowid: usernameRow.rowid })
      expect((yield* store.all()).username).toBeUndefined()
      expect((yield* DbRegistry.rows({ table: "runtime_setting" })).rowCount).toBe(1)
    }),
  )

  it.effect("update with no known columns errors instead of writing", () =>
    Effect.gen(function* () {
      const error = yield* DbRegistry.updateRow({
        table: "runtime_setting",
        rowid: 1,
        values: { bogus: 1 },
      }).pipe(Effect.flip)
      expect(error._tag).toBe("DbRegistry.RegistryError")
    }),
  )
})
