import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Remote-access R7: the instance's durable identity (one row, minted lazily on first read by
// InstanceIdentityStore). Advertised over mDNS and reported by /global/health so clients can
// recognize the same instance behind different URLs.
export default {
  id: "20260721190000_add_instance_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`instance_identity\` (
          \`id\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
