import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725160000_add_session_thinking_budget",
  up(tx) {
    return Effect.gen(function* () {
      // The per-chat thinking-budget override (the composer's Tuning control). Tri-state like the other
      // feature columns: 1/0 = this chat's explicit stance, NULL = inherit (parent chain, then the model's
      // own budget). NULL default, so every existing session keeps inheriting.
      yield* tx.run(`ALTER TABLE \`session\` ADD \`thinking_budget\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
