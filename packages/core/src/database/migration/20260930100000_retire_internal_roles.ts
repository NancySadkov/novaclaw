import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930100000_retire_internal_roles",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        INSERT INTO agent_retirement (agent, retired_at)
        SELECT history.agent, unixepoch() * 1000 FROM (
          SELECT name AS agent FROM agent_config
          UNION SELECT agent FROM session
        ) AS history WHERE history.agent IN ('general', 'explore', 'messenger', 'recipe')
          AND NOT EXISTS (SELECT 1 FROM agent_retirement r WHERE r.agent = history.agent);
      `)
      yield* tx.run(`DELETE FROM agent_config WHERE name IN ('general', 'explore', 'messenger', 'recipe');`)
      yield* tx.run(
        `DELETE FROM agent_setting WHERE key = 'default_agent' AND json_extract(value, '$') IN ('general', 'explore', 'messenger', 'recipe');`,
      )
      yield* tx.run(`
        WITH RECURSIVE retired(id) AS (
          SELECT id FROM session WHERE agent IN ('general', 'explore', 'messenger', 'recipe')
          UNION SELECT s.id FROM session s JOIN retired r ON s.parent_id = r.id
        )
        UPDATE session SET time_archived = coalesce(time_archived, unixepoch() * 1000)
        WHERE id IN (SELECT id FROM retired);
      `)
      yield* tx.run(
        `UPDATE messenger_account SET agent_id = 'nova' WHERE agent_id IN ('general', 'explore', 'messenger', 'recipe');`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
