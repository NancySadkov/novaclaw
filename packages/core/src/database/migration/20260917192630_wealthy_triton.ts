import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917192630_wealthy_triton",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` DROP COLUMN \`system_prompt_override\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
