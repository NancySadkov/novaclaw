import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260928002558_work_project_directory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`work_project\` ADD \`directory\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
