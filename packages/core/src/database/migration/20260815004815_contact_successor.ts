import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815004815_contact_successor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`community_contact\` ADD \`successor_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
