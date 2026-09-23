import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import { CalendarStore } from "../src/schedule/store"
import migration from "../src/database/migration/20260923161501_late_wendell_vaughn"

describe("agent schedule migration", () => {
  test("gives unowned schedules to Nova and preserves fire history", async () => {
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
        yield* db.transaction((tx) => migration.up(tx))
        const schedule = yield* CalendarStore.get(db, "cal_old")
        const fires = yield* CalendarStore.fires(db, "cal_old")
        const columns = yield* db.all<{ name: string; notnull: number }>(`PRAGMA table_info(calendar_schedule);`)
        return { schedule, fires, columns }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
    expect(result.schedule?.agent).toBe("nova")
    expect(result.fires.map((fire) => fire.id)).toEqual(["fire_old"])
    expect(result.columns.find((column) => column.name === "agent")?.notnull).toBe(1)
  })
})
