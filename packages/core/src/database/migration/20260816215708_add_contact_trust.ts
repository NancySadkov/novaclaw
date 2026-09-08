import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816215708_add_contact_trust",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`community_contact\` ADD \`trust\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
