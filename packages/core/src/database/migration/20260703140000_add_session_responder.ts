import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// B10: the live-control responder — "nova" (AI answers, default) | "operator" (a human
// took control, so the runner stops auto-responding). NULL = inherit/default = nova.
export default {
  id: "20260703140000_add_session_responder",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`responder\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
