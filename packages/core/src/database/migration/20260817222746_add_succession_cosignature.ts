import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * 🔴 Successor co-signatures (P2P review 2026-08-17, finding 1.4).
 *
 * ⚠️ **Hand-written over the generator's output, and the reason is SQLite rather than taste.**
 * `drizzle-kit` emitted `ALTER TABLE … ADD \`successor_signature\` text NOT NULL`, which SQLite
 * refuses outright: adding a NOT NULL column needs a non-null default, whatever the row count. The
 * usual escape — give it `DEFAULT ''` — is worse than it looks here: every existing row would then
 * read as co-signed while carrying nothing, which is the exact shape this column exists to make
 * impossible.
 *
 * So the table is recreated and the old rows are DROPPED. That is not data loss worth avoiding:
 * every statement written before this migration carries one signature, so it can no longer verify,
 * and keeping it would only mean handing peers statements they are obliged to refuse. Successor
 * statements are gossip — an instance re-learns anyone else's by asking, and its OWN is re-issued by
 * rotating. (There is no production database; `AGENTS.md` — schema gate is migration equivalence.)
 */
export default {
  id: "20260817222746_add_succession_cosignature",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE IF EXISTS \`community_succession\`;`)
      yield* tx.run(`
        CREATE TABLE \`community_succession\` (
          \`network_id\` text PRIMARY KEY,
          \`successor_id\` text NOT NULL,
          \`claimed_at\` integer NOT NULL,
          \`signature\` text NOT NULL,
          \`successor_signature\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
