import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * 🔴 **THE ANONYMOUS AGENTS ARE RETIRED — `build` and `plan` stop being agents.**
 *
 * Owner, 2026-09-27: *"get completely rid of build and plan both as colleagues and as machinery — we
 * have completely retired the anonymous agents. So they are not just ghosts polluting NovaClaw."*
 *
 * They were POSTURE agents: permission modes wearing an agent's shape (owner, 2026-08-22), which is
 * what made them ghosts — an id on the roster that owns no chat, answers no message, and appears in
 * every listing that forgets to filter. `plan` had no runtime path at all (`permissionMode: "plan"` is
 * the live mechanism and is completely independent). `build` was still being WRITTEN by the composer,
 * which is the last writer this migration cannot reach and the app-side half of the fix.
 *
 * ## The three ties, resolved against the vision rather than deferred
 *
 * **1. The live `build`/`plan` ROOTS (measured 2026-08-24 at 55–98 and 76 on the owner's own
 * instances) are ARCHIVED, not reassigned and not deleted.**
 *
 * Reassigning them to a colleague would be the tempting move and it is wrong twice over: a colleague
 * has ONE chat (AGENTS.md: *"a chat is a component of a colleague"*, enforced by
 * `session_agent_live_root_idx`), so 98 rows would collide with one, and every one of them would
 * inherit that colleague's private memory scope — 98 unrelated conversations reading and writing one
 * officer's cabinet. Deleting them would throw away the user's own history to tidy an index.
 *
 * Archiving is the reversible half, and it is what the product already does everywhere else a chat
 * stops being live: `Clear chat`, `ColleagueHandoff.retire`, the one-chat-per-agent collapse. The
 * transcripts stay on disk and stay reachable; they stop being sessions that can run. **The index
 * exemption has to go with them** — a `build` root that is archived satisfies nothing, and leaving
 * `agent NOT IN ('build','plan')` in the predicate is what let 98 of them accumulate in the first
 * place. With every posture root archived the predicate can be the plain uniqueness it was always
 * meant to be, and a posture can never hold a live root again.
 *
 * **2. The `agent_config` rows are DELETED, not left behind.** These two were code-seeded by the
 * plugin, not user config, so a stored row is an artifact of an older boot — and the plugin re-declares
 * its agents every boot, which is why leaving them would resurrect the ghosts. A user who had renamed
 * or briefed `build` loses that, and the vision says that is the right trade: a permission mode is not
 * an identity, and AGENTS.md's table has four slots (shareholder, CEO, officer, sub-agent) with no
 * row for one.
 *
 * **3. The retirement LEDGER records them**, so the pool of names and every "who used to be here"
 * reader learns these two are gone rather than never having existed. The ledger already exists and
 * already derives retired agents from `session.agent`, so the honest insertion is the one that
 * migration above would have made *if it had run after this one* — which is precisely why this
 * inserts explicitly instead of leaving it to inference.
 *
 * ⚠️ **Order matters and it is load-bearing.** The `agent_config` delete runs BEFORE the archive, so a
 * failure halfway cannot leave an agent row with no agent behind it in the roster sense. And the index
 * is rebuilt LAST, because rebuilding it while a live `build` root still existed is exactly the
 * failure this whole migration exists to prevent — SQLite would refuse the `CREATE UNIQUE INDEX`.
 */
export default {
  id: "20260927201500_retire_the_anonymous_agents",
  up(tx) {
    return Effect.gen(function* () {
      // 2. The stored rows, first: these are code-seeded artifacts of an older boot, and the plugin
      // re-declares them, so a surviving row is a resurrection rather than a memory.
      yield* tx.run(`DELETE FROM agent_config WHERE name IN ('build', 'plan');`)

      // 1. The live posture roots, archived. `time_archived` is the same column `Clear chat` and
      // `retire` write, so the transcripts remain listable and restorable through the paths that
      // already know how to read an archived chat. Children (`parent_id IS NOT NULL`) are left alone:
      // a worker's `agent` is an override the chain walk fills, not ownership of a live root, and
      // archiving a worker's parent here would take live delegated work down with it.
      yield* tx.run(`
        UPDATE session
        SET time_archived = coalesce(time_archived, unixepoch() * 1000)
        WHERE agent IN ('build', 'plan')
          AND parent_id IS NULL
          AND time_archived IS NULL;
      `)

      // 3. The ledger, so the pool and the "who used to be here" readers know these two are gone.
      // `max(time_created)` is the newest evidence either id ever ran, which is what the existing
      // derivation would have computed for them.
      yield* tx.run(`
        INSERT INTO agent_retirement (agent, retired_at)
        SELECT history.agent, max(history.time_created)
        FROM (
          SELECT agent, time_created FROM session WHERE agent IN ('build', 'plan')
          UNION ALL
          SELECT json_extract(data, '$.sender') AS agent, time_created
          FROM session_message
          WHERE type = 'colleague'
            AND json_extract(data, '$.sender') IN ('build', 'plan')
        ) AS history
        WHERE NOT EXISTS (SELECT 1 FROM agent_retirement WHERE agent = history.agent)
        GROUP BY history.agent;
      `)

      // The index, rebuilt WITHOUT the posture exemption. Every posture root is archived above, so
      // this is safe to run — and it is the ratchet: `POSTURE_IDS` can no longer exempt itself from
      // uniqueness, so a posture can never again hold a live root on a fresh or migrated instance.
      yield* tx.run(`DROP INDEX IF EXISTS session_agent_live_root_idx;`)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_agent_live_root_idx
        ON session (agent)
        WHERE parent_id IS NULL AND time_archived IS NULL AND agent IS NOT NULL;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
