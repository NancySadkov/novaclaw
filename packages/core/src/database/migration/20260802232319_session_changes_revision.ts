import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802232319_session_changes_revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_from\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_to\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`summary_complete\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
