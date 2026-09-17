import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917133451_smiling_red_ghost",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE \`skill_config\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
