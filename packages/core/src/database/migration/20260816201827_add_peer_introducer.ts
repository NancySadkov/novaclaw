import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816201827_add_peer_introducer",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`community_peer\` ADD \`introduced_by\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
