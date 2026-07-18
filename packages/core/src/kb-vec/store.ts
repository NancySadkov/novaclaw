export * as KbVecStore from "./store"

import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"

// KB-V — the physical vector/keyword search layer under the document KB
// (notes/kb-vector-plan.md §3). This module owns:
//   - resolving + loading the vendored sqlite-vec loadable extension for this platform;
//   - the two virtual tables (kb_chunk_vec via vec0, kb_chunk_fts via FTS5) and the
//     external-content triggers that keep the FTS index synced with kb_chunk;
//   - the float32 blob encoding vec0 expects for embeddings.
//
// Everything is idempotent and degrade-first: FTS5 is compiled into every SQLite we ship, so
// keyword search always works; the vec table exists only when the extension loads, and callers
// branch on the returned capability instead of failing (embedder/extension down ≠ KB down).
//
// CONTRACT: kb_chunk_vec and kb_chunk_fts hold chunks of ACTIVE documents only — the write path
// (P2) deletes a doc's chunks when it is superseded/retracted, so search never needs a
// valid_to filter on the hot path (the fts query still joins kb_doc defensively).

export const DEFAULT_DIMS = 1024

export interface Capability {
  readonly vector: boolean
}

const BINARY: Record<string, string> = {
  "win32-x64": "vec0.dll",
  "linux-x64": "vec0.so",
  "linux-arm64": "vec0.so",
  "darwin-x64": "vec0.dylib",
  "darwin-arm64": "vec0.dylib",
}

// The vendored loadable binaries live in core/resources/sqlite-vec/<platform>-<arch>/ (v0.1.9,
// from the upstream GitHub release). NOVACLAW_SQLITE_VEC_DIR overrides for packaged apps whose
// bundler relocated resources (point it at a dir holding the right vec0.* for the platform).
export const binaryPath = (): string | undefined => {
  const key = `${process.platform}-${process.arch}`
  const file = BINARY[key]
  if (file === undefined) return undefined
  const override = process.env["NOVACLAW_SQLITE_VEC_DIR"]
  const candidates = [
    ...(override ? [path.join(override, file)] : []),
    path.resolve(import.meta.dirname, "../../resources/sqlite-vec", key, file),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

// vec0 KNN table: cosine metric, `relation` as a partition key so staged/core scoping is an
// index-level shard (not a post-filter), doc_id + snippet as auxiliary payload columns
// (retrievable in the KNN SELECT without a JOIN, never filterable — exactly their role).
export const vecTableSql = (dims: number = DEFAULT_DIMS) => `
  CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_vec USING vec0(
    chunk_id text PRIMARY KEY,
    embedding float[${dims}] distance_metric=cosine,
    relation text partition key,
    +doc_id text,
    +snippet text
  )`

// FTS5 external-content index over kb_chunk.text, trigger-synced (the standard recipe): writes
// to kb_chunk maintain the index automatically, so the P2 write path stays plain drizzle.
export const ftsSchemaSql = (): string[] => [
  `CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_fts USING fts5(text, content='kb_chunk', content_rowid='rowid')`,
  `CREATE TRIGGER IF NOT EXISTS kb_chunk_fts_ai AFTER INSERT ON kb_chunk BEGIN
     INSERT INTO kb_chunk_fts(rowid, text) VALUES (new.rowid, new.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS kb_chunk_fts_ad AFTER DELETE ON kb_chunk BEGIN
     INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS kb_chunk_fts_au AFTER UPDATE OF text ON kb_chunk BEGIN
     INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
     INSERT INTO kb_chunk_fts(rowid, text) VALUES (new.rowid, new.text);
   END`,
]

// vec0 binds embeddings as little-endian float32 blobs (JSON works too but is ~5x the bytes).
export const vecBlob = (vector: ReadonlyArray<number> | Float32Array): Uint8Array => {
  const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength)
}

interface RunSql {
  run: (sql: string) => Effect.Effect<unknown, unknown>
}

interface ExtensionClient {
  loadExtension: (path: string) => Effect.Effect<void, unknown>
}

const extensionClient = (db: unknown): ExtensionClient | undefined => {
  const client = (db as { $client?: { loadExtension?: unknown } }).$client
  return typeof client?.loadExtension === "function" ? (client as ExtensionClient) : undefined
}

/**
 * Idempotently prepares the search layer on the given drizzle database: the FTS index +
 * triggers always; the vec0 table when the extension resolves AND loads on this connection.
 * Never fails the caller — a missing/unloadable extension degrades to `{ vector: false }`
 * (FTS-only search), which `Kb.stats` surfaces so the degrade is visible, not silent.
 */
export const ensure = (db: RunSql, options?: { dims?: number }) =>
  Effect.gen(function* () {
    for (const statement of ftsSchemaSql()) yield* Effect.orDie(db.run(statement))
    const binary = binaryPath()
    const client = extensionClient(db)
    if (binary === undefined || client === undefined) return { vector: false } satisfies Capability
    const loaded = yield* client.loadExtension(binary).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!loaded) return { vector: false } satisfies Capability
    yield* Effect.orDie(db.run(vecTableSql(options?.dims)))
    return { vector: true } satisfies Capability
  })
