import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814172542_add_instance_identity_keypair",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`instance_identity\` ADD \`public_key\` text;`)
      yield* tx.run(`ALTER TABLE \`instance_identity\` ADD \`secret_key\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
