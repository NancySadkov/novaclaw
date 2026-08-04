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

  // The migration journal is the one table a Developer-mode edit can make UNBOOTABLE: deleting a
  // row replays that migration (usually a CREATE TABLE that then throws inside applyOnly, which is
  // orDie'd), inserting a bogus id silently SKIPS a real migration. All three write paths refuse
  // it; browsing stays open. The last block is the NEGATIVE CONTROL — `data_migration` is an
  // unrelated table and must remain fully editable, proving the guard matches EXACTLY.
  it.effect("refuses every write to the migration journal, and still permits data_migration", () =>
    Effect.gen(function* () {
      const names = (yield* DbRegistry.tables()).map((table) => table.name)
      // Neither assertion below means anything unless both tables genuinely exist.
      expect(names).toContain("migration")
      expect(names).toContain("data_migration")

      // Reading the journal is allowed — an operator diagnosing a bad upgrade needs it.
      const journal = yield* DbRegistry.rows({ table: "migration", limit: 500 })
      expect(journal.columns).toContain("id")
      expect(journal.rowCount).toBeGreaterThan(0)
      const victim = journal.rows[0]!

      const writes = {
        update: DbRegistry.updateRow({
          table: "migration",
          rowid: victim.rowid,
          values: { time_completed: 0 },
        }),
        insert: DbRegistry.insertRow({
          table: "migration",
          values: { id: "99999999999999_not_a_real_migration", time_completed: 0 },
        }),
        delete: DbRegistry.deleteRow({ table: "migration", rowid: victim.rowid }),
      }
      for (const [what, write] of Object.entries(writes)) {
        const error = yield* write.pipe(Effect.flip)
        expect(`${what}:${error._tag}`).toBe(`${what}:DbRegistry.RegistryError`)
        expect(error.message).toContain("read-only")
      }
      // A failed mutation never reports success — and it never half-wrote either.
      const after = yield* DbRegistry.rows({ table: "migration", limit: 500 })
      expect(after.rowCount).toBe(journal.rowCount)
      expect(after.rows.map((row) => row.values.id)).toEqual(journal.rows.map((row) => row.values.id))
      expect(after.rows.find((row) => row.rowid === victim.rowid)?.values.time_completed).toBe(
        victim.values.time_completed,
      )

      // NEGATIVE CONTROL: `data_migration` (data backfills) is a DIFFERENT table that merely shares
      // the substring. Every write path must still work on it, or the guard is over-matching.
      yield* DbRegistry.insertRow({
        table: "data_migration",
        values: { name: "registry-guard-probe", time_completed: 1 },
      })
      const probe = (yield* DbRegistry.rows({ table: "data_migration" })).rows.find(
        (row) => row.values.name === "registry-guard-probe",
      )
      expect(probe).toBeDefined()
      yield* DbRegistry.updateRow({ table: "data_migration", rowid: probe!.rowid, values: { time_completed: 2 } })
      expect(
        (yield* DbRegistry.rows({ table: "data_migration" })).rows.find((row) => row.rowid === probe!.rowid)?.values
          .time_completed,
      ).toBe(2)
      yield* DbRegistry.deleteRow({ table: "data_migration", rowid: probe!.rowid })
      expect((yield* DbRegistry.rows({ table: "data_migration" })).rowCount).toBe(0)
    }),
  )
})
