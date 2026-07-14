import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

// KB-A storage — the in-house PoC fact store (see kb.ts for the API + write discipline).
// Lives in its own sql.ts so drizzle.config.ts's schema globs (./src/**/sql.ts) pick it up:
// schema.gen.ts full-regenerates FROM these globs, and a table defined outside them is
// silently dropped from fresh-install bootstrap (that bit kb_fact once — never again).
export const KbFactTable = sqliteTable(
  "kb_fact",
  {
    id: text().primaryKey(),
    subject: text().notNull(),
    predicate: text().notNull(),
    object: text().notNull(),
    relation: text().$type<"core" | "staged">().notNull(),
    source: text(),
    agent: text(),
    confidence: real(),
    valid_from: integer().notNull(),
    valid_to: integer(),
    superseded_by: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("kb_fact_subject_idx").on(table.subject, table.valid_to),
    index("kb_fact_predicate_idx").on(table.predicate, table.valid_to),
    index("kb_fact_object_idx").on(table.object, table.valid_to),
  ],
)
