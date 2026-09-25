import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925165054_agent_retirement_ledger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_retirement\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`agent\` text NOT NULL,
          \`retired_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`agent_retirement_agent_at_idx\` ON \`agent_retirement\` (\`agent\`,\`retired_at\`);`,
      )
      yield* tx.run(`
        INSERT INTO agent_retirement (agent, retired_at)
        SELECT config.name, config.time_created
        FROM agent_config AS config
        WHERE EXISTS (
          SELECT 1 FROM session
          WHERE session.agent = config.name
            AND session.time_created <= config.time_created
        ) OR EXISTS (
          SELECT 1 FROM session_message
          WHERE session_message.type = 'colleague'
            AND json_extract(session_message.data, '$.sender') = config.name
            AND session_message.time_created <= config.time_created
        );
      `)
      yield* tx.run(`
        INSERT INTO agent_retirement (agent, retired_at)
        SELECT history.agent, max(history.observed_at)
        FROM (
          SELECT session.agent AS agent, session.time_created AS observed_at
          FROM session
          WHERE session.agent IS NOT NULL
          UNION ALL
          SELECT json_extract(session_message.data, '$.sender') AS agent,
            session_message.time_created AS observed_at
          FROM session_message
          WHERE session_message.type = 'colleague'
            AND typeof(json_extract(session_message.data, '$.sender')) = 'text'
        ) AS history
        WHERE history.agent <> 'nova'
          AND NOT EXISTS (
            SELECT 1 FROM agent_config
            WHERE agent_config.name = history.agent
          )
        GROUP BY history.agent;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
