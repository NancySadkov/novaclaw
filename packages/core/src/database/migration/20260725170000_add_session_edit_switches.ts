import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260725170000_add_session_edit_switches",
  up(tx) {
    return Effect.gen(function* () {
      // The two former permission MODES, demoted to per-chat Tuning switches so the mode picker can stay
      // three plain postures. Tri-state like the other feature columns; NULL = inherit, and since neither
      // has a global `{ enabled }` block the effective default is OFF.
      yield* tx.run(`ALTER TABLE \`session\` ADD \`surgical_edits\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`ask_before_changes\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
