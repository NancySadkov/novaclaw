import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// The per-session Strict-harness override (the composer's Strict switch): a JSON column
// { enabled?, attempts?, wallMinutes? }; NULL = inherit (parent chain, then global config.strict).
// Mirrors session/sql.ts and the session block in schema.gen.ts — keep the three in sync.
export default {
  id: "20260714090000_add_session_strict",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`strict\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
