import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// KB-V P1 (notes/kb-vector-plan.md §3): the document tier under the vector-RAG KB — kb_doc
// (provenance + dated moves, mirroring kb_fact's write discipline) and kb_chunk (the retrieval
// unit). The kb_chunk_vec / kb_chunk_fts VIRTUAL tables are deliberately not migrated here:
// they are extension-backed and ensured idempotently at KB open (KbVecStore.ensure), so a
// missing sqlite-vec binary can never wedge a database migration.
export default {
  id: "20260718110000_add_kb_vec_docs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`kb_doc\` (
          \`id\` text PRIMARY KEY,
          \`title\` text NOT NULL,
          \`text\` text NOT NULL,
          \`relation\` text NOT NULL,
          \`source\` text,
          \`agent\` text,
          \`confidence\` real,
          \`content_hash\` text NOT NULL,
          \`embed_model\` text,
          \`valid_from\` integer NOT NULL,
          \`valid_to\` integer,
          \`superseded_by\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`kb_chunk\` (
          \`id\` text PRIMARY KEY,
          \`doc_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`text\` text NOT NULL,
          \`token_estimate\` integer NOT NULL,
          \`embed_status\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`kb_doc_relation_idx\` ON \`kb_doc\` (\`relation\`,\`valid_to\`);`)
      yield* tx.run(`CREATE INDEX \`kb_doc_hash_idx\` ON \`kb_doc\` (\`content_hash\`,\`valid_to\`);`)
      yield* tx.run(`CREATE INDEX \`kb_doc_source_idx\` ON \`kb_doc\` (\`source\`,\`valid_to\`);`)
      yield* tx.run(`CREATE INDEX \`kb_chunk_doc_idx\` ON \`kb_chunk\` (\`doc_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`kb_chunk_embed_status_idx\` ON \`kb_chunk\` (\`embed_status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
