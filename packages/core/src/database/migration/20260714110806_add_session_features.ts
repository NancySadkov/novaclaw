import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260714110806_add_session_features",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`introspection\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`quality\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`affective\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
