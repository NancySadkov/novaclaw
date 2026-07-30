import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730201959_add_messenger_source_access",
  up(tx) {
    return Effect.gen(function* () {
      // todo.md ruling 7 — chat privacy is a SOURCE LABEL, not a transport enum. Two columns, not
      // one, because the driver's guess and the user's word are different facts and collapsing them
      // is how a guess becomes a declaration. Both NULLable: an existing row has no proposal and
      // nobody has been asked, which is the "no evidence" state, not a value to backfill.
      yield* tx.run(`ALTER TABLE \`messenger_chat\` ADD \`proposed_access\` text;`)
      yield* tx.run(`ALTER TABLE \`messenger_chat\` ADD \`declared_access\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
