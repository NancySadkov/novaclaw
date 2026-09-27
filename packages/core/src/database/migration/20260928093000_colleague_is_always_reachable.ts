import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * 🔴 **`colleague` IS NOT A DIAL. Every stored rule about it is removed.**
 *
 * Owner, 2026-09-27, on a live instance: *"Sopitis … tries to call colleague tool to report the
 * superior, nova, about the completed task, but it gets access denied `Deferred tool colleague is not
 * callable in this session`. Please remove the entire `not callable in this session` permission
 * check, so any tool, deferred or not will be callable, and also remove any machinery which existed
 * solely to support this `not callable` permission level, since agent should always be able to
 * message its superior, subordinates and colleagues who are subordinates of its superior."*
 *
 * ## What the code fixes, and what only this migration can
 *
 * `floor()` no longer writes `colleague` as `officer ? "allow" : "deny"` — it grants it to everyone.
 * That alone changes nothing for an agent that already has a stored layer, because
 * `config/plugin/agent.ts` pushes the floor only on the `!exists` branch: a colleague created by an
 * older build keeps whatever it was minted with, forever.
 *
 * Measured on the owner's own store, read-only, 2026-09-27 — seven `agent_config` rows:
 *
 * | agent       | rules | stored `colleague` |
 * |-------------|-------|---------------------|
 * | ariadne     |    18 | `allow`             |
 * | geryon      |    18 | `allow`             |
 * | **sopitis** | **25** | **`deny`**        |
 * | nova, daedalus, myron, xenia | 0 | (from code) |
 *
 * Sopitis is an officer that was minted by the `officer: false` path. Two further tells confirm that
 * rather than merely suggest it: it carries **no `spawn inherit` grant at all**, which the officer
 * floor has held since 2026-08-22, and its scratch grants are the non-glob pair
 * (`…/scratch/sopitis` and `…/scratch/sopitis/*`) where geryon carries only the glob. So this is a
 * real officer carrying a real non-officer floor, and the deny is a stale layer rather than a
 * decision anybody recorded on purpose.
 *
 * ## Why the rule is deleted rather than flipped to `allow`
 *
 * Flipping would leave a rule that reads as the operator's choice and answers a question nobody
 * asked. The code is the single source for this grant, exactly as it is for the scratch grants, and
 * `floor()` re-asserts it on every boot for an agent that does not yet exist. A stored copy can only
 * ever disagree with the code, which is precisely how this happened.
 *
 * ## Why deleting it cannot widen what an agent may actually reach
 *
 * The org chart was never in this rule. `ColleagueRoute.route` (`session/colleague-route.ts`) decides
 * every message: a worker is redirected to its parent, Nova reaches anyone, self-address is refused,
 * a superior or same-tier colleague is delivered directly, and **anything else is redirected to the
 * sender's superior rather than delivered** — AGENTS.md's *"the chain of command is preserved"*,
 * already shipped and untouched by this change. `hire`/`retire` remain Nova's alone through
 * `mayStaff`. So this hands an officer back the ability to *ask*; it hands nobody the ability to
 * *reach*.
 */
export default {
  id: "20260928093000_colleague_is_always_reachable",
  up(tx) {
    return Effect.gen(function* () {
      // A stored `deny colleague` is a tool WITHDRAWN from a horizon (`whollyDisabled`), so it is a
      // capability absence rather than a refusal: the model is handed a name it cannot use, which is
      // the message the owner reported. `allow` rows go too — the floor supplies the grant, and a
      // second copy is a second thing to keep in sync.
      //
      // Written as a rebuild rather than a `json_remove` over generated paths: the rules live two
      // levels down (`layers[i].permissions[j]`), and enumerating those to remove is unreadable and
      // index-fragile, because removing one shifts every index after it. `json_group_array` over
      // `json_each` is order-preserving and does not care what it skipped.
      //
      // Two SQLite details are load-bearing and BOTH were got wrong on the first attempt, so they
      // are recorded rather than left to be rediscovered. An unaliased `json_each` exposes `value`,
      // not the loop variable you had in mind — which is why every reference here is `layer.value`.
      // And `json_type(layer.value, '$.permissions') = 'array'` is the guard that keeps a layer with
      // no permissions array from erroring, because `json_each` on a missing key raises rather than
      // yielding nothing; a layer without one is the COMMON case, since the seed writes a bare layer
      // for a colleague that inherits everything.
      //
      // Verified against the owner's own seven `agent_config` rows before being committed: sopitis
      // 25 → 24 rules with every other rule intact, ariadne and geryon 18 → 17 (their redundant
      // `allow` removed), and the four rule-less rows untouched.
      yield* tx.run(`
        UPDATE agent_config
        SET layers = (
          SELECT json_group_array(
            CASE
              WHEN json_type(layer.value, '$.permissions') = 'array'
                THEN json_set(layer.value, '$.permissions', (
                  SELECT json_group_array(rule.value)
                  FROM json_each(layer.value, '$.permissions') AS rule
                  WHERE json_extract(rule.value, '$.action') <> 'colleague'
                ))
              ELSE layer.value
            END
          )
          FROM json_each(agent_config.layers) AS layer
        )
        WHERE EXISTS (
          SELECT 1
          FROM json_each(agent_config.layers) AS candidate
          WHERE EXISTS (
            SELECT 1
            FROM json_each(candidate.value, '$.permissions') AS rule
            WHERE json_extract(rule.value, '$.action') = 'colleague'
          )
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
