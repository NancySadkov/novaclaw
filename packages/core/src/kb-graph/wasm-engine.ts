import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The in-process Ladybug graph-memory engine (WASM) — the single engine that runs EVERYWHERE
// (notes/kb-graph-plan.md §2.0, the 2026-07-19 pivot). The native addon can't run in a phone app and
// segfaults under Bun; the WASM build runs in-process under Bun/Node (and, later, the browser) with
// vector + FTS BUILT-IN — no sidecar, no native binary, no extension vendoring. This module owns the
// graph in-process and IS the single-writer (§4.1).
//
// Persistence = MEMFS + snapshot (measured: real-disk NODEFS is fragile on Windows — a drive-letter
// path hits an emscripten getcwd bug; an explicit NODEFS mount + on-disk index creation hangs; MEMFS
// (pure-RAM) is rock-solid). So the DB lives in the emscripten MEMFS at `/<memfs>/graph`, and we
// SNAPSHOT it to a real directory: after writes CHECKPOINT (merges the WAL into one `graph` file),
// then copy the MEMFS files out to disk; on open, copy them back in before opening. Snapshots are
// debounced + forced on flush/close, so the loss window on a hard crash is bounded (the durability↔
// perf trade the owner accepted).
//
// ⚠️ WASM API: `@ladybugdb/wasm-core/nodejs/sync` is require-only (createRequire); `init()` once,
// globally; queries are SYNC (`conn.query`), rows via `.getAllObjects()`; params via prepare→execute.
// Open a SUBDIR (`/x/graph`), never the FS root. POSIX virtual paths only.

export type MemoryKind = "entity" | "episode" | "passage"
export type Relation = "staged" | "core"

export interface MemoryInput {
  readonly id: string
  readonly kind: MemoryKind
  readonly text: string
  readonly name?: string
  readonly scope: string
  readonly source?: string
  readonly agent?: string
  readonly confidence?: number
  readonly relation?: Relation
  readonly embedding?: readonly number[]
  readonly validFrom?: string
}

export interface EdgeInput {
  readonly from: string
  readonly to: string
  readonly type: string
  readonly scope: string
  readonly source?: string
  readonly confidence?: number
}

export interface SearchInput {
  readonly query?: string
  readonly embedding?: readonly number[]
  readonly k?: number
  readonly scopes?: readonly string[]
  readonly kinds?: readonly MemoryKind[]
}

export interface MemoryRow {
  readonly id: string
  readonly kind: MemoryKind
  readonly text: string
  readonly name: string | null
  readonly scope: string
  readonly source: string | null
  readonly confidence: number | null
  readonly relation: Relation
}

export interface SearchHit extends MemoryRow {
  readonly score: number
}

const DEFAULT_DIM = 1024
const RRF_K = 60
const SNAPSHOT_DEBOUNCE_MS = 1_000

const vectorLiteral = (v: readonly number[]) => `[${v.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`

// --- global WASM module (init once) ------------------------------------------------------------

let lbugModule: any
let initPromise: Promise<any> | undefined
let memfsCounter = 0

const loadWasm = (): Promise<any> => {
  if (!initPromise) {
    initPromise = (async () => {
      const require = createRequire(import.meta.url)
      const lbug = require("@ladybugdb/wasm-core/nodejs/sync")
      await lbug.init()
      lbugModule = lbug
      return lbug
    })()
  }
  return initPromise
}

export class WasmMemory {
  private readonly lbug: any
  private readonly db: any
  private readonly conn: any
  private readonly memfsDir: string
  private readonly realDir: string
  readonly dim: number
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private closed = false
  // The WASM connection is single-threaded: an op does several awaited engine calls that must be
  // atomic w.r.t. the debounced snapshot (a CHECKPOINT interleaved mid-result-read corrupts it). All
  // public ops + persist run through this serial lock so they never interleave.
  private lock: Promise<unknown> = Promise.resolve()

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private constructor(lbug: any, db: any, conn: any, memfsDir: string, realDir: string, dim: number) {
    this.lbug = lbug
    this.db = db
    this.conn = conn
    this.memfsDir = memfsDir
    this.realDir = realDir
    this.dim = dim
  }

  /** Open (or create) the memory graph persisted at real directory `realDir`. Loads the WASM engine,
   *  restores any prior snapshot into MEMFS, opens the DB there, and ensures the schema + indexes. */
  static async open(realDir: string, opts: { dim?: number } = {}): Promise<WasmMemory> {
    const dim = opts.dim ?? DEFAULT_DIM
    const lbug = await loadWasm()
    const FS = lbug.getFS()
    // ⚠️ Load-bearing: the emscripten working dir is backed by a HIDDEN PERSISTENT store that survives
    // across processes (measured: reusing a fixed path like `/kbmem0` showed 6 stale nodes on a "fresh"
    // open, because a plain counter resets to 0 each process and re-hits the prior run's leftover DB
    // file). So the scratch path must be UNIQUE PER PROCESS — pid + a per-open counter — so a new
    // instance never collides with a stale file. Durability is OUR real-disk snapshot, restored below;
    // this scratch dir is throwaway.
    const memfsDir = `/kbmem_${process.pid}_${memfsCounter++}`
    try {
      FS.mkdir(memfsDir)
    } catch {
      /* exists */
    }
    // Restore our snapshot: copy the real-disk files into the scratch dir before opening.
    mkdirSync(realDir, { recursive: true })
    for (const f of readdirSync(realDir)) {
      FS.writeFile(`${memfsDir}/${f}`, readFileSync(join(realDir, f)))
    }
    const db = new lbug.Database(`${memfsDir}/graph`)
    const conn = new lbug.Connection(db)
    const store = new WasmMemory(lbug, db, conn, memfsDir, realDir, dim)
    await store.ensureSchema()
    return store
  }

  // Ladybug params go through prepare→execute (query() alone runs a bare statement). The sync build's
  // calls may be sync or promise-returning — awaiting a non-promise is harmless.
  private async q(cypher: string, params?: Record<string, unknown>): Promise<any> {
    if (!params) return this.conn.query(cypher)
    const stmt = await this.conn.prepare(cypher)
    return this.conn.execute(stmt, params)
  }

  private async rows(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const result = await this.q(cypher, params)
    return (await result.getAllObjects()) as Record<string, unknown>[]
  }

  private async ddl(cypher: string): Promise<void> {
    try {
      await this.q(cypher)
    } catch (error) {
      if (!/already exists|Binder exception: .* exists/i.test(String((error as Error).message))) throw error
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.ddl(
      `CREATE NODE TABLE Memory(
         id STRING, kind STRING, text STRING, name STRING, scope STRING,
         source STRING, agent STRING, confidence DOUBLE, relation STRING,
         t_valid TIMESTAMP, t_invalid TIMESTAMP, t_created TIMESTAMP, t_expired TIMESTAMP,
         embedding FLOAT[${this.dim}], PRIMARY KEY(id))`,
    )
    await this.ddl(
      `CREATE REL TABLE Rel(
         FROM Memory TO Memory, type STRING, scope STRING, source STRING, confidence DOUBLE,
         t_valid TIMESTAMP, t_invalid TIMESTAMP, t_created TIMESTAMP, t_expired TIMESTAMP)`,
    )
    await this.ddl(`CALL CREATE_VECTOR_INDEX('Memory', 'mem_vec', 'embedding', metric := 'cosine')`)
    await this.ddl(`CALL CREATE_FTS_INDEX('Memory', 'mem_fts', ['text', 'name'])`)
    await this.persist() // flush the freshly-created schema to disk
  }

  // --- persistence (MEMFS ↔ real disk snapshot) ------------------------------------------------

  /** Force a snapshot now (serialized with ops): checkpoint the WAL, then mirror the MEMFS db files
   *  to disk. */
  async flush(): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = undefined
    }
    if (!this.dirty && existsSync(join(this.realDir, "graph"))) return
    await this.serialize(() => this.persist())
  }

  private async persist(): Promise<void> {
    try {
      await this.q(`CHECKPOINT`)
    } catch {
      /* nothing to checkpoint / transient */
    }
    const FS = this.lbug.getFS()
    const memFiles = (FS.readdir(this.memfsDir) as string[]).filter((f) => f !== "." && f !== "..")
    mkdirSync(this.realDir, { recursive: true })
    for (const f of memFiles) {
      writeFileSync(join(this.realDir, f), Buffer.from(FS.readFile(`${this.memfsDir}/${f}`) as Uint8Array))
    }
    // Drop stale on-disk files the checkpoint merged away (e.g. a prior .wal) so restore stays clean.
    for (const f of readdirSync(this.realDir)) {
      if (!memFiles.includes(f)) rmSync(join(this.realDir, f), { force: true })
    }
    this.dirty = false
  }

  /** After a mutation: mark dirty and (re)arm a debounced snapshot so bursts coalesce into one write. */
  private touch(): void {
    this.dirty = true
    if (this.closed) return
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined
      void this.serialize(() => this.persist()).catch(() => {})
    }, SNAPSHOT_DEBOUNCE_MS)
    this.snapshotTimer.unref?.()
  }

  // --- ops (Cypher identical to the native store; the surface never changes across engines) -----

  addMemory(input: MemoryInput): Promise<void> {
    if (input.embedding && input.embedding.length !== this.dim)
      return Promise.reject(new Error(`embedding length ${input.embedding.length} != store dim ${this.dim}`))
    return this.serialize(async () => {
      const validFrom = input.validFrom ? `timestamp($validFrom)` : `current_timestamp()`
      const embedding = input.embedding ? `, embedding: ${vectorLiteral(input.embedding)}` : ``
      await this.q(
        `CREATE (:Memory {
           id: $id, kind: $kind, text: $text, name: $name, scope: $scope,
           source: $source, agent: $agent, confidence: $confidence, relation: $relation,
           t_valid: ${validFrom}, t_created: current_timestamp()${embedding} })`,
        {
          id: input.id,
          kind: input.kind,
          text: input.text,
          name: input.name ?? null,
          scope: input.scope,
          source: input.source ?? null,
          agent: input.agent ?? null,
          confidence: input.confidence ?? null,
          relation: input.relation ?? "staged",
          ...(input.validFrom ? { validFrom: input.validFrom } : {}),
        },
      )
      this.touch()
    })
  }

  addEdge(input: EdgeInput): Promise<void> {
    return this.serialize(async () => {
      await this.q(
        `MATCH (a:Memory {id: $from}), (b:Memory {id: $to})
         CREATE (a)-[:Rel { type: $type, scope: $scope, source: $source, confidence: $confidence,
                            t_valid: current_timestamp(), t_created: current_timestamp() }]->(b)`,
        {
          from: input.from,
          to: input.to,
          type: input.type,
          scope: input.scope,
          source: input.source ?? null,
          confidence: input.confidence ?? null,
        },
      )
      this.touch()
    })
  }

  /** Hybrid retrieval: vector KNN (if `embedding`) + FTS (if `query`), RRF-fused, scope/validity filtered. */
  search(input: SearchInput): Promise<SearchHit[]> {
    return this.serialize(async () => this._search(input))
  }

  private async _search(input: SearchInput): Promise<SearchHit[]> {
    const k = input.k ?? 10
    const pool = Math.max(k * 4, 20)
    const ranks = new Map<string, number>()
    const fuse = (ids: string[]) => ids.forEach((id, i) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + i + 1)))

    if (input.embedding) {
      if (input.embedding.length !== this.dim)
        throw new Error(`query embedding length ${input.embedding.length} != store dim ${this.dim}`)
      const hits = await this.rows(
        `CALL QUERY_VECTOR_INDEX('Memory', 'mem_vec', ${vectorLiteral(input.embedding)}, ${pool})
         RETURN node.id AS id ORDER BY distance`,
      )
      fuse(hits.map((h) => String(h.id)))
    }
    if (input.query && input.query.trim()) {
      const hits = await this.rows(
        `CALL QUERY_FTS_INDEX('Memory', 'mem_fts', $query) RETURN node.id AS id ORDER BY score DESC`,
        { query: input.query },
      )
      fuse(hits.map((h) => String(h.id)))
    }
    if (ranks.size === 0) return []

    const ordered = [...ranks.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    const scopeFilter = input.scopes ? `AND m.scope IN $scopes` : ``
    const kindFilter = input.kinds ? `AND m.kind IN $kinds` : ``
    const props = await this.rows(
      `MATCH (m:Memory) WHERE m.id IN $ids AND m.t_invalid IS NULL ${scopeFilter} ${kindFilter}
       RETURN m.id AS id, m.kind AS kind, m.text AS text, m.name AS name, m.scope AS scope,
              m.source AS source, m.confidence AS confidence, m.relation AS relation`,
      {
        ids: ordered,
        ...(input.scopes ? { scopes: input.scopes } : {}),
        ...(input.kinds ? { kinds: input.kinds } : {}),
      },
    )
    const byId = new Map(props.map((p) => [String(p.id), p]))
    const hits: SearchHit[] = []
    for (const id of ordered) {
      const p = byId.get(id)
      if (!p) continue
      hits.push({
        id,
        kind: p.kind as MemoryKind,
        text: String(p.text ?? ""),
        name: (p.name as string | null) ?? null,
        scope: String(p.scope),
        source: (p.source as string | null) ?? null,
        confidence: (p.confidence as number | null) ?? null,
        relation: (p.relation as Relation) ?? "staged",
        score: ranks.get(id)!,
      })
      if (hits.length >= k) break
    }
    return hits
  }

  neighbors(
    id: string,
    opts: { scopes?: readonly string[]; k?: number } = {},
  ): Promise<{ id: string; type: string; text: string }[]> {
    return this.serialize(async () => {
      const scopeFilter = opts.scopes ? `AND n.scope IN $scopes` : ``
      const rows = await this.rows(
        `MATCH (m:Memory {id: $id})-[r:Rel]->(n:Memory)
         WHERE r.t_invalid IS NULL AND n.t_invalid IS NULL ${scopeFilter}
         RETURN n.id AS id, r.type AS type, n.text AS text LIMIT ${opts.k ?? 25}`,
        { id, ...(opts.scopes ? { scopes: opts.scopes } : {}) },
      )
      return rows.map((r) => ({ id: String(r.id), type: String(r.type), text: String(r.text ?? "") }))
    })
  }

  path(from: string, to: string, maxHops = 5): Promise<{ ids: string[]; hops: number } | null> {
    return this.serialize(async () => {
      const rows = await this.rows(
        `MATCH p = (a:Memory {id: $from})-[:Rel* SHORTEST 1..${Math.max(1, maxHops | 0)}]->(b:Memory {id: $to})
         RETURN length(p) AS hops, nodes(p) AS ns`,
        { from, to },
      )
      const r = rows[0]
      if (!r) return null
      const ns = (r.ns as Array<{ id?: unknown }>) ?? []
      return { hops: Number(r.hops), ids: ns.map((n) => String(n?.id)) }
    })
  }

  invalidate(id: string, at?: string): Promise<void> {
    return this.serialize(async () => {
      const when = at ? `timestamp($at)` : `current_timestamp()`
      await this.q(`MATCH (m:Memory {id: $id}) SET m.t_invalid = ${when}`, { id, ...(at ? { at } : {}) })
      this.touch()
    })
  }

  purge(id: string): Promise<void> {
    return this.serialize(async () => {
      await this.q(`MATCH (m:Memory {id: $id}) DETACH DELETE m`, { id })
      this.touch()
    })
  }

  clearScope(scope: string): Promise<void> {
    return this.serialize(async () => {
      await this.q(`MATCH (m:Memory) WHERE m.scope = $scope DETACH DELETE m`, { scope })
      this.touch()
    })
  }

  stats(): Promise<{ total: number; valid: number }> {
    return this.serialize(async () => {
      const rows = await this.rows(
        `MATCH (m:Memory) RETURN count(m) AS total, count(CASE WHEN m.t_invalid IS NULL THEN 1 END) AS valid`,
      )
      const r = rows[0] ?? {}
      return { total: Number(r.total ?? 0), valid: Number(r.valid ?? 0) }
    })
  }

  /** Consolidation (§1.3.4): promote each still-valid SESSION-scope memory to a GLOBAL twin (so
   *  auto-extracted facts become cross-session), then supersede the session original bitemporally
   *  (invalidate — kept in history, dropped from search). Deduped by a content-hash global id, so the
   *  same fact from two sessions collapses to one global memory, and re-running is idempotent (already-
   *  invalidated originals are skipped). Returns the number promoted. Safe to run repeatedly in the
   *  background. */
  consolidate(): Promise<number> {
    return this.serialize(async () => {
      // Only AUTO-EXTRACTED session memories flow up. A deliberate `remember` scoped "session" is a
      // "this chat only" note the user chose — never force it global.
      const rows = await this.rows(
        `MATCH (m:Memory)
         WHERE m.t_invalid IS NULL AND starts_with(m.scope, 'session:') AND m.source = 'auto-extract'
         RETURN m.id AS id, m.kind AS kind, m.text AS text, m.name AS name,
                m.source AS source, m.confidence AS confidence, m.relation AS relation`,
      )
      let promoted = 0
      for (const row of rows) {
        const text = String(row.text ?? "")
        if (!text) continue
        const gid = "mem_g" + createHash("sha256").update(`global\n${text.trim().toLowerCase()}`).digest("hex").slice(0, 24)
        const existing = await this.rows(`MATCH (g:Memory {id: $gid}) WHERE g.t_invalid IS NULL RETURN g.id AS id`, { gid })
        if (existing.length === 0) {
          await this.q(
            `CREATE (:Memory {
               id: $id, kind: $kind, text: $text, name: $name, scope: 'global',
               source: $source, confidence: $confidence, relation: $relation,
               t_valid: current_timestamp(), t_created: current_timestamp() })`,
            {
              id: gid,
              kind: String(row.kind ?? "episode"),
              text,
              name: (row.name as string | null) ?? null,
              source: (row.source as string | null) ?? null,
              confidence: (row.confidence as number | null) ?? null,
              relation: (row.relation as string) ?? "staged",
            },
          )
        }
        // Supersede the session original (bitemporal): it's now represented globally.
        await this.q(`MATCH (m:Memory {id: $id}) SET m.t_invalid = current_timestamp()`, { id: String(row.id) })
        promoted++
      }
      if (promoted > 0) this.touch()
      return promoted
    })
  }

  /** Flush a final snapshot and close the DB + connection. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flush()
    try {
      await this.conn.close?.()
      await this.db.close?.()
    } catch {
      /* already closed */
    }
  }
}
