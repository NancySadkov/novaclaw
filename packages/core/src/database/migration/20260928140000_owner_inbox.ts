import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260928140000_owner_inbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`UPDATE agent_config SET layers = (
        SELECT json_group_array(json(CASE WHEN json_extract(value, '$.name') = 'Owner'
          THEN json_remove(value, '$.name', '$.hidden', '$.disabled', '$.kind', '$.superior')
          ELSE json_remove(value, '$.hidden', '$.disabled', '$.kind', '$.superior') END))
        FROM json_each(agent_config.layers)
      ) WHERE name = 'owner'`)
    })
  },
} satisfies DatabaseMigration.Migration
