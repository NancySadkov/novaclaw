import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// F1g: the legacy V1 `message`/`part` tables are retired. V2-native transcripts live in
// `session_message` (untouched); pre-F0 legacy transcripts lapse with their rows (owner decision
// ①: no backfill — throwaway pre-release data). `session_share` drops here too (its feature was
// removed with ④). Session-LEVEL data (titles, list, timestamps) survives on `session`.
// Drop `part` before `message` (part has an FK onto message); table drops cascade their indexes.
export default {
  id: "20260708000000_drop_legacy_message_part",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`part_message_id_id_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`part_session_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`message_session_time_created_id_idx\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`part\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`message\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`session_share\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
