import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Calendar fire history needs a terminal projection separate from the admission status. Existing
// rows are honest about what was known before this column existed: a recorded error is failed, and
// every admitted or claimed run remains pending until its session reaches a terminal state.
export default {
  id: "20260905110000_calendar_fire_outcome",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`calendar_fire\` ADD COLUMN \`outcome\` text NOT NULL DEFAULT 'pending';`)
      yield* tx.run(`UPDATE \`calendar_fire\` SET \`outcome\` = 'failed' WHERE \`status\` = 'error';`)
    })
  },
} satisfies DatabaseMigration.Migration
