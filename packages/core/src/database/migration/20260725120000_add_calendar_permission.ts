import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Calendar permissions + work folder: add the optional per-schedule permission mode (plan/ask/surgical/
// bypass/yolo). The work FOLDER reuses the existing `location_json` column (P1) — no new column. Mirrors
// schedule/calendar.sql.ts + the calendar_schedule block in schema.gen.ts (permission_mode is appended LAST,
// matching ALTER TABLE ADD COLUMN).
export default {
  id: "20260725120000_add_calendar_permission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`calendar_schedule\` ADD \`permission_mode\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
