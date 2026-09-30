import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930013142_project_kickoff_delivery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project_notice\` ADD \`delivery\` text DEFAULT 'steer' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
