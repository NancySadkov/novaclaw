import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// KB-G P6 retired the sqlite-vec document tier (kb-vector-plan → kb-graph-plan): the CODE went, but
// existing databases kept the tables, because `kb_chunk_vec`/`kb_chunk_fts` were created LAZILY by the
// old store and so were never part of the declared schema the migration generator diffs against.
//
// That leftover was not inert. MEASURED 2026-07-20: `DbRegistry.tables()` counts every table, and
// `count(*)` on `kb_chunk_vec` throws `no such module: vec0` now that the extension is gone — which
// took out `/registry/tables` entirely, so the Registry app listed NOTHING. That endpoint is now
// per-table tolerant, but the dead tables should still go.
//
// ⚠️ `kb_chunk_vec` itself is deliberately NOT dropped. A virtual table can only be dropped by its own
// module, and dropping it raises the same `no such module: vec0` — which would make this migration
// fail on every boot. Reclaiming it would mean re-adding the sqlite-vec dependency purely to delete
// something, which is a worse trade than leaving ~0 rows of dead schema behind. Its shadow tables
// (`kb_chunk_vec_*`) are plain tables but are left with it: they are meaningless alone, and removing
// them while the parent remains would only confuse a later reader.
//
// The FTS5 module IS built into SQLite, so `kb_chunk_fts` drops normally and takes its own shadow
// tables (`_data`, `_idx`, `_docsize`, `_config`, `_ai`, `_ad`, `_au`) with it. Verified against a
// VACUUM INTO snapshot of a real dev database before writing this.
//
// No data conversion by design: KB-V's tier is dead, memory now lives in the Ladybug graph, and the
// pre-release doctrine is that no production database exists.
export default {
  id: "20260720120000_drop_kb_vec_leftovers",
  up(tx) {
    return Effect.gen(function* () {
      // FTS first, then the chunk/doc pair — children before parents.
      yield* tx.run("DROP TABLE IF EXISTS `kb_chunk_fts`;")
      yield* tx.run("DROP TABLE IF EXISTS `kb_chunk`;")
      yield* tx.run("DROP TABLE IF EXISTS `kb_doc`;")
    })
  },
} satisfies DatabaseMigration.Migration
