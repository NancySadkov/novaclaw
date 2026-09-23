import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import { ScheduleStore } from "../src/schedule/store"
import { DatabaseMigration } from "../src/database/migration"
import ownershipMigration from "../src/database/migration/20260923161501_late_wendell_vaughn"
import scheduleMigration from "../src/database/migration/20260923190000_agent_schedule"

describe("agent schedule migration", () => {
  test("gives unowned schedules to Nova and drops old unconfirmed run history", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(`
          CREATE TABLE calendar_schedule (
            id text PRIMARY KEY, title text NOT NULL, recurrence_json text NOT NULL,
            tz_offset_min integer NOT NULL, prompt text NOT NULL, agent text,
            enabled integer NOT NULL, next_fire_at integer, last_fired_at integer,
            time_created integer NOT NULL, time_updated integer NOT NULL
          );
        `)
        yield* db.run(`
          CREATE TABLE calendar_fire (
            id text PRIMARY KEY, schedule_id text NOT NULL, occurrence_millis integer NOT NULL,
            fired_at integer NOT NULL, session_id text, status text NOT NULL,
            outcome text NOT NULL,
            FOREIGN KEY (schedule_id) REFERENCES calendar_schedule(id) ON DELETE CASCADE
          );
        `)
        yield* db.run(`
          INSERT INTO calendar_schedule VALUES
            ('cal_old', '', '{"kind":"once","at":1000}', 0, 'work', NULL, 1, 1000, NULL, 1, 1);
        `)
        yield* db.run(`INSERT INTO calendar_fire VALUES ('fire_old', 'cal_old', 1000, 1000, NULL, 'skipped', 'pending');`)
        yield* db.transaction((tx) => ownershipMigration.up(tx))
        yield* db.transaction((tx) => scheduleMigration.up(tx))
        const schedule = yield* ScheduleStore.get(db, "cal_old")
        const fires = yield* ScheduleStore.fires(db, "cal_old")
        const columns = yield* db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(agent_schedule);`)
        const windowColumns = yield* db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(agent_schedule_window);`)
        return { schedule, fires, columns, windowColumns }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
    expect(result.schedule?.agent).toBe("nova")
    expect(result.fires).toEqual([])
    expect(result.columns.find((column) => column.name === "agent")?.notnull).toBe(1)
    const fresh = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      return {
        columns: yield* db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(agent_schedule);`),
        windowColumns: yield* db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`PRAGMA table_info(agent_schedule_window);`),
      }
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
    expect(result.columns).toEqual(fresh.columns)
    expect(result.windowColumns).toEqual(fresh.windowColumns)
  })
})
