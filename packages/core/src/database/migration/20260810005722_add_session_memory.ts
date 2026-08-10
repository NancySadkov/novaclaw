import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810005722_add_session_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`memory\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
