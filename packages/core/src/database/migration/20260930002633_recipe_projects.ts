import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930002633_recipe_projects",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`work_project\` ADD \`recipe\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
