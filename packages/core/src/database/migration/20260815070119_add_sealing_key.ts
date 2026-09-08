import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815070119_add_sealing_key",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`instance_identity\` ADD \`sealing_public_key\` text;`)
      yield* tx.run(`ALTER TABLE \`instance_identity\` ADD \`sealing_secret_key\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
