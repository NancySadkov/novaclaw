import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// ONE LIVE CHAT PER COLLEAGUE — the data half, which must land BEFORE the unique index that follows
// it, or the index cannot be created at all.
//
// 🔴 **Measured, not anticipated.** On the owner's own instances (2026-08-24): `novaclaw.db` had
// `nova` holding TWO live root chats — "Greeting" and "New session" — and `novaclaw-local.db` had six
// colleagues over the limit, 45 surplus chats between them. `CREATE UNIQUE INDEX` on that data fails,
// and a failed migration leaves the database at the last completed one: an upgrade that bricks.
//
// ⚠️ **ARCHIVES, never deletes.** "Clear chat" already archives rather than deletes — it is the
// product's own way of setting a conversation aside — so nothing is lost here and the rows remain
// readable. This is also why archiving is not a demotion of the loser's content: the duplicate was
// ALREADY unreachable before this ran. The roster is the only door into a colleague's chat and it can
// show exactly one, so the older row was invisible while its tokens still rolled up into that
// colleague's totals. This migration makes the stored state match the state the user could already
// see, and it is what lets the constraint exist at all.
//
// ⚠️ **The winner is the NEWEST by `time_updated`**, which is the tiebreak `liveRootFor` already uses
// to answer "which chat is this colleague's". Choosing differently here would mean the migration and
// the running code disagree about the same question — and the disagreement would only show up as a
// chat that vanished.
//
// The `id` comparison is the deterministic tiebreak for rows sharing a timestamp: without it, two
// rows updated in the same millisecond each see the other as newer, so NEITHER is archived and the
// index still fails. A migration whose outcome depends on row order is not a migration.
//
// Exclusions match the index and both application checks exactly — roots only (a sub-agent inherits
// its officer's id), live only, and never the POSTURES `build`/`plan`, which are the mode most chats
// run as rather than colleagues.
export default {
  id: "20260824180000_collapse_duplicate_colleague_chats",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        "UPDATE `session` SET `time_archived` = CAST(strftime('%s','now') AS INTEGER) * 1000 " +
          "WHERE `parent_id` IS NULL " +
          "  AND `time_archived` IS NULL " +
          "  AND `agent` IS NOT NULL " +
          "  AND `agent` NOT IN ('build', 'plan') " +
          "  AND EXISTS ( " +
          "    SELECT 1 FROM `session` AS `newer` " +
          "    WHERE `newer`.`agent` = `session`.`agent` " +
          "      AND `newer`.`parent_id` IS NULL " +
          "      AND `newer`.`time_archived` IS NULL " +
          "      AND ( `newer`.`time_updated` > `session`.`time_updated` " +
          "         OR (`newer`.`time_updated` = `session`.`time_updated` AND `newer`.`id` > `session`.`id`) ) " +
          "  );",
      )
    })
  },
} satisfies DatabaseMigration.Migration
