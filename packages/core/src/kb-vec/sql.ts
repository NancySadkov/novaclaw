import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

// KB-V storage — the vector-RAG document tier (notes/kb-vector-plan.md §3). Documents carry the
// same provenance + dated-moves write discipline as the old fact store: an update stamps
// valid_to + superseded_by and inserts a new row; agent writes stay relation="staged" forever.
// Lives in its own sql.ts so drizzle.config.ts's schema globs (./src/**/sql.ts) pick it up:
// schema.gen.ts full-regenerates FROM these globs, and a table defined outside them is
// silently dropped from fresh-install bootstrap (that bit kb_fact once — never again).
//
// The two VIRTUAL tables beside these (kb_chunk_vec via the sqlite-vec extension, kb_chunk_fts
// via FTS5) are deliberately NOT here: extension-backed virtual tables can't ride the drizzle
// schema pipeline, and the vec table must not break boot when the extension is absent. They are
// ensured lazily + idempotently by KbVecStore.ensure at KB open (FTS-only degrade when vec0
// can't load).
export const KbDocTable = sqliteTable(
  "kb_doc",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    text: text().notNull(),
    relation: text().$type<"core" | "staged">().notNull(),
    source: text(),
    agent: text(),
    confidence: real(),
    content_hash: text().notNull(),
    embed_model: text(),
    valid_from: integer().notNull(),
    valid_to: integer(),
    superseded_by: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("kb_doc_relation_idx").on(table.relation, table.valid_to),
    index("kb_doc_hash_idx").on(table.content_hash, table.valid_to),
    index("kb_doc_source_idx").on(table.source, table.valid_to),
  ],
)

export const KbChunkTable = sqliteTable(
  "kb_chunk",
  {
    id: text().primaryKey(),
    doc_id: text().notNull(),
    seq: integer().notNull(),
    text: text().notNull(),
    token_estimate: integer().notNull(),
    embed_status: text().$type<"pending" | "done" | "failed">().notNull(),
  },
  (table) => [
    index("kb_chunk_doc_idx").on(table.doc_id, table.seq),
    index("kb_chunk_embed_status_idx").on(table.embed_status),
  ],
)
