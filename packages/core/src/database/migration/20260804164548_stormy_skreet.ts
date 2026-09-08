import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804164548_stormy_skreet",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_execution\` ADD \`tool_call_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_execution\` ADD \`tool_name\` text;`)
      yield* tx.run(`ALTER TABLE \`session_execution\` ADD \`tool_side_effect\` text;`)
      yield* tx.run(`ALTER TABLE \`session_execution\` ADD \`tool_state\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
