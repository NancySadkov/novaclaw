// The Ladybug graph-memory store — the engine core of the KB-G memory sidecar
// (notes/kb-graph-plan.md §1). Runs under NODE only (the native @ladybugdb/core addon segfaults
// under Bun — P0); tested with node:test. Plain async TS: no Effect here (the Bun-side client owns
// that); this is the process that literally owns the graph, so it also IS the single-writer (§4.1).
//
// The graph: ONE `Memory` node table (kind = entity | episode | passage) + a typed `Rel` edge
// table, both carrying `scope` (global | session:<id>) + the bi-temporal quartet
// (t_valid/t_invalid/t_created/t_expired) + provenance (source/agent/confidence) + `relation`
// (staged | core). Vector index (incremental — new inserts are immediately searchable, P1a-verified)
// + FTS over text/name. Search is hybrid (vector KNN + FTS, RRF-fused, scope- and validity-filtered).

import * as lbug from "@ladybugdb/core"

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
  /** Embedding vector; length MUST equal the store's `dim`. Omit for a not-yet-embedded memory. */
  readonly embedding?: readonly number[]
  /** Valid-time start (ISO, world time). Defaults to now. */
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
  /** Scopes to search (a memory matches if its scope is in this set). Defaults to all scopes. */
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
const RRF_K = 60 // reciprocal-rank-fusion damping (standard)

const vectorLiteral = (v: readonly number[]) => `[${v.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`

export class MemoryStore {
  private readonly db: lbug.Database
  private readonly conn: lbug.Connection
  readonly dim: number

  private constructor(db: lbug.Database, conn: lbug.Connection, dim: number) {
    this.db = db
    this.conn = conn
    this.dim = dim
  }

  /** Open (or create) the memory graph at `path`, load the vector+fts extensions, and ensure the
   *  schema + indexes. Idempotent — safe to call on an existing store. */
  static async open(path: string, opts: { dim?: number } = {}): Promise<MemoryStore> {
    const dim = opts.dim ?? DEFAULT_DIM
    const db = new lbug.Database(path)
    const conn = new lbug.Connection(db)
    const store = new MemoryStore(db, conn, dim)
    await store.loadExtensions()
    await store.ensureSchema()
    // Flush the freshly-created schema so even a crash immediately after boot leaves a clean WAL.
    await store.checkpoint()
    return store
  }

  // Ladybug has no `query(cypher, params)` — plain `query()` takes only a progress callback;
  // parameters go through prepare()→execute(). A single Cypher statement yields one QueryResult
  // (multi-statement yields an array — we only run single statements, so unwrap defensively).
  private async q(cypher: string, params?: Record<string, unknown>): Promise<lbug.QueryResult> {
    const result = params
      ? await this.conn.execute(await this.conn.prepare(cypher), params as Record<string, lbug.LbugValue>)
      : await this.conn.query(cypher)
    return (Array.isArray(result) ? result[result.length - 1] : result) as lbug.QueryResult
  }

  private async rows(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const result = await this.q(cypher, params)
    return (await result.getAll()) as Record<string, unknown>[]
  }

  // Flush the WAL into the main DB file after every mutation. ⚠️ This is not an optimization — it's a
  // correctness fix: a bare reopen of a graph whose writer was HARD-KILLED with a dirty WAL (segfault,
  // OOM, taskkill, power loss) CRASHES the native engine natively (no catchable error — measured,
  // v0.18.2 on Windows), which would turn the supervisor's auto-restart into a crash loop. Checkpointing
  // after each write keeps the on-disk WAL empty, so an abrupt death leaves a clean, reopenable graph
  // (the "never breaks" vision). Affordable because memory writes are async + off the turn hot-path
  // (§4.1). Best-effort: a transient "nothing to checkpoint / active transaction" is swallowed — the
  // next mutation flushes it.
  private async checkpoint(): Promise<void> {
    try {
      await this.q(`CHECKPOINT`)
    } catch {
      /* transient — the next mutation checkpoints */
    }
  }

  /** DDL/idempotence helper: run and swallow "already exists" (so open() is repeatable). */
  private async ddl(cypher: string): Promise<void> {
    try {
      await this.q(cypher)
    } catch (error) {
      if (!/already exists|Binder exception: .* exists/i.test(String((error as Error).message))) throw error
    }
  }

  private async loadExtensions(): Promise<void> {
    for (const ext of ["vector", "fts"]) {
      try {
        await this.q(`LOAD EXTENSION ${ext}`)
      } catch {
        // Not yet present in ~/.lbdb/extension — fetch it (online) then load. Airgap builds
        // pre-vendor the binary so the first LOAD above already succeeds (P1a-verified).
        await this.q(`INSTALL ${ext}`)
        await this.q(`LOAD EXTENSION ${ext}`)
      }
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
    // Vector index is incremental (P1a-verified) — created once, updated on insert.
    await this.ddl(`CALL CREATE_VECTOR_INDEX('Memory', 'mem_vec', 'embedding', metric := 'cosine')`)
    await this.ddl(`CALL CREATE_FTS_INDEX('Memory', 'mem_fts', ['text', 'name'])`)
  }

  async addMemory(input: MemoryInput): Promise<void> {
    if (input.embedding && input.embedding.length !== this.dim)
      throw new Error(`embedding length ${input.embedding.length} != store dim ${this.dim}`)
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
    await this.checkpoint()
  }

  async addEdge(input: EdgeInput): Promise<void> {
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
    await this.checkpoint()
  }

  /** Hybrid retrieval: vector KNN (if `embedding`) + FTS (if `query`), RRF-fused, filtered to the
   *  requested scopes and to currently-VALID memories (t_invalid IS NULL). */
  async search(input: SearchInput): Promise<SearchHit[]> {
    const k = input.k ?? 10
    const pool = Math.max(k * 4, 20)
    const ranks = new Map<string, number>() // id -> fused RRF score

    const fuse = (ids: string[]) => {
      ids.forEach((id, i) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + i + 1)))
    }

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
    // Fetch props for the fused candidates, applying scope + validity (+ kind) filters, then
    // re-order by the fused score and cut to k.
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

  /** One-hop typed neighbours of a memory, valid edges only, optionally scope-filtered. */
  async neighbors(id: string, opts: { scopes?: readonly string[]; k?: number } = {}): Promise<
    { id: string; type: string; text: string }[]
  > {
    const scopeFilter = opts.scopes ? `AND n.scope IN $scopes` : ``
    const rows = await this.rows(
      `MATCH (m:Memory {id: $id})-[r:Rel]->(n:Memory)
       WHERE r.t_invalid IS NULL AND n.t_invalid IS NULL ${scopeFilter}
       RETURN n.id AS id, r.type AS type, n.text AS text LIMIT ${opts.k ?? 25}`,
      { id, ...(opts.scopes ? { scopes: opts.scopes } : {}) },
    )
    return rows.map((r) => ({ id: String(r.id), type: String(r.type), text: String(r.text ?? "") }))
  }

  /** Shortest path (by edge count) between two memories, if one exists within `maxHops`. */
  async path(from: string, to: string, maxHops = 5): Promise<{ ids: string[]; hops: number } | null> {
    const rows = await this.rows(
      `MATCH p = (a:Memory {id: $from})-[:Rel* SHORTEST 1..${Math.max(1, maxHops | 0)}]->(b:Memory {id: $to})
       RETURN length(p) AS hops, nodes(p) AS ns`,
      { from, to },
    )
    const r = rows[0]
    if (!r) return null
    // A path node value spreads its properties as direct keys (NodeValue: `{ _label, _id, ...props }`).
    const ns = (r.ns as Array<{ id?: unknown }>) ?? []
    return { hops: Number(r.hops), ids: ns.map((n) => String(n?.id)) }
  }

  /** Bi-temporal supersede: mark a memory invalid as of `at` (default now) — history is preserved. */
  async invalidate(id: string, at?: string): Promise<void> {
    const when = at ? `timestamp($at)` : `current_timestamp()`
    await this.q(`MATCH (m:Memory {id: $id}) SET m.t_invalid = ${when}`, {
      id,
      ...(at ? { at } : {}),
    })
    await this.checkpoint()
  }

  /** Hard delete a memory and its edges — for secrets (§4.3); no history kept. */
  async purge(id: string): Promise<void> {
    await this.q(`MATCH (m:Memory {id: $id}) DETACH DELETE m`, { id })
    await this.checkpoint()
  }

  /** Delete every memory (and its edges) in a scope — e.g. clear one chat's memory. */
  async clearScope(scope: string): Promise<void> {
    await this.q(`MATCH (m:Memory) WHERE m.scope = $scope DETACH DELETE m`, { scope })
    await this.checkpoint()
  }

  async stats(): Promise<{ total: number; valid: number }> {
    const rows = await this.rows(
      `MATCH (m:Memory) RETURN count(m) AS total, count(CASE WHEN m.t_invalid IS NULL THEN 1 END) AS valid`,
    )
    const r = rows[0] ?? {}
    return { total: Number(r.total ?? 0), valid: Number(r.valid ?? 0) }
  }

  async close(): Promise<void> {
    // Close the connection before the database so the on-disk write lock is fully released — a
    // dangling connection keeps the lock and blocks the next open (Ladybug is single-writer).
    await this.conn.close()
    await this.db.close()
  }
}
