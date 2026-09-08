import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815050952_add_channel_listed",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`community_channel\` ADD \`listed\` integer DEFAULT false NOT NULL;`)
      /**
       * 🔴 Existing installs joined the default channel BEFORE this column existed, so they took the
       * column default — unlisted — and discovery would have found nothing for every instance that
       * already had the app. Only the upgrade path shows this: a fresh database lists it at join time
       * and looks perfectly correct, which is the same asymmetry that bricked a boot on this schema
       * earlier today.
       *
       * Matched CANONICALLY (lowercased, leading `#` stripped), because the row holds whatever
       * spelling the user first typed and the room's identity has never been the literal string.
       */
      yield* tx.run(`UPDATE \`community_channel\` SET \`listed\` = true WHERE lower(ltrim(name, '#')) = 'novaclaw';`)
    })
  },
} satisfies DatabaseMigration.Migration
