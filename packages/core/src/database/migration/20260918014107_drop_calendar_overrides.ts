import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918014107_drop_calendar_overrides",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`calendar_schedule\` DROP COLUMN \`model\`;`)
      yield* tx.run(`ALTER TABLE \`calendar_schedule\` DROP COLUMN \`location_json\`;`)
      yield* tx.run(`ALTER TABLE \`calendar_schedule\` DROP COLUMN \`permission_mode\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
