import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924120000_retire_auto_prompting",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("UPDATE `session` SET `type` = 'goal-oriented' WHERE `type` = 'auto-prompting';")
    })
  },
} satisfies DatabaseMigration.Migration
