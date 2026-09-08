import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815003907_add_community_message_nonce",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`community_message\` ADD \`nonce\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
