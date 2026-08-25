export * as MemoryClient from "./memory-client"

import { Context, Effect, Layer, Schema } from "effect"
import type { MemoryAccess } from "./memory-access"

// The memory tier's Effect-facing surface (notes/kb-graph-plan.md §2.0): the `Interface` the kb tool +
// auto-recall/extract hooks depend on, its types + tagged error, and the ways to construct it —
// `fromEngine` (adapt the in-process WASM engine, ./wasm-engine.ts), `stub` (in-memory, for tests),
// `disabled` (degraded — memory unavailable but the instance still boots), and `proxy` (hand over a
// live client immediately, swap the real engine in once it opens). Errors collapse to a single tagged
// MemoryError so callers DEGRADE gracefully (memory down ≠ turn fails). The engine is injected (no
// engine import here) so this stays a thin, engine-agnostic contract — the surface that never changes
// across engine pivots (native sidecar → WASM in-process).

export class MemoryError extends Schema.TaggedErrorClass<MemoryError>()("MemoryClient.MemoryError", {
  reason: Schema.String,
}) {}

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
  /** Embedding vector; length MUST equal the sidecar's `dim`. Omit for a not-yet-embedded memory. */
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
  /** Valid-time (ISO) — when the fact became true; the recency signal for P8 ordering. The engine
   *  returns it, so the type must carry it or ranking silently loses recency. Absent = unknown. */
  readonly validAt?: string
}

export interface Neighbor {
  readonly id: string
  readonly type: string
  readonly text: string
}

export interface PathResult {
  readonly ids: string[]
  readonly hops: number
}

export interface Stats {
  readonly total: number
  readonly valid: number
}

export interface ListInput {
  readonly scopes?: readonly string[]
  readonly kinds?: readonly MemoryKind[]
  readonly includeInvalid?: boolean
  readonly limit?: number
  readonly offset?: number
}

export interface GraphInput {
  readonly scopes?: readonly string[]
  readonly limit?: number
}

export interface EdgeRow {
  readonly from: string
  readonly to: string
  readonly type: string
}

/**
 * How the slice was chosen — see `graph-slice.ts`.
 *
 * ⚠️ Carried on the RESULT, not derivable by the client. "600 nodes came back" and "600 nodes exist"
 * look identical from outside, so a viewer without this cannot tell a complete map from a corner of
 * one, and will quietly present the corner as the whole.
 */
export interface GraphSlice {
  readonly partial: boolean
  readonly total: number
  readonly returned: number
  readonly omitted: number
  readonly reason: "complete" | "connected-first" | "scan-capped"
}

export interface MemoryGraph {
  readonly nodes: ReadonlyArray<MemoryRow>
  readonly edges: ReadonlyArray<EdgeRow>
  readonly slice: GraphSlice
}

export interface Interface {
  /** Liveness probe — never fails (returns false if the sidecar is unreachable). */
  readonly health: () => Effect.Effect<boolean>
  readonly addMemory: (input: MemoryInput) => Effect.Effect<void, MemoryError>
  readonly addEdge: (input: EdgeInput) => Effect.Effect<void, MemoryError>
  readonly search: (input: SearchInput) => Effect.Effect<ReadonlyArray<SearchHit>, MemoryError>
  /**
   * 🔴 `access` is REQUIRED on every id-based operation, and THAT is the fix — not the checks inside
   * them. NC-SEC-016 happened because the scope set was OPTIONAL: `neighbors` filtered "only when the
   * caller supplied `opts.scopes`", so a call site that forgot got a WIDER query rather than an error.
   * Measured against the shipping engine on 2026-08-25, one chat could read another chat's private
   * text through a global neighbour and then hard-delete it by the id it had just learned.
   *
   * A required parameter moves that from "every call site must remember" to "the compiler finds them
   * all", and `MemoryAccess` makes the privileged case something a reader can SEE and name
   * (`MemoryAccess.owner()`) rather than something reached by leaving an argument out.
   */
  readonly neighbors: (
    id: string,
    access: MemoryAccess,
    opts?: { k?: number },
  ) => Effect.Effect<ReadonlyArray<Neighbor>, MemoryError>
  readonly path: (
    from: string,
    to: string,
    access: MemoryAccess,
    maxHops?: number,
  ) => Effect.Effect<PathResult | null, MemoryError>
  readonly invalidate: (id: string, access: MemoryAccess, at?: string) => Effect.Effect<void, MemoryError>
  readonly purge: (id: string, access: MemoryAccess) => Effect.Effect<void, MemoryError>
  /** Move a whole scope's memories elsewhere — what a retirement does instead of deleting them. */
  readonly moveScope: (from: string, to: string) => Effect.Effect<void, MemoryError>
  readonly clearScope: (scope: string) => Effect.Effect<void, MemoryError>
  /** Erase every memory in every scope — see `wasm-engine.ts`. Returns how many were removed. */
  readonly eraseAll: () => Effect.Effect<number, MemoryError>
  /** Discard the pre-roster leak: `global` rows written by auto-extraction. Idempotent. */
  readonly discardLegacyGlobalExtracts: () => Effect.Effect<number, MemoryError>
  readonly stats: () => Effect.Effect<Stats, MemoryError>
  /** Enumerate memories (viewer/editor) — no query, newest first, filterable + paginated. */
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<MemoryRow>, MemoryError>
  /** The graph slice for the visualizer: nodes + the edges among them. */
  readonly graph: (input?: GraphInput) => Effect.Effect<MemoryGraph, MemoryError>
}

// The Effect service tag — the memory tier the kb tool + auto-recall/extract hooks depend on. The
// deferred inner layer (Memory.serviceNode) provides the live client via `fromEngine`; tests provide
// a client via `stub`/`disabled` through `layerWith`.
export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MemoryClient") {}

/** The in-process engine surface the client adapts (WasmMemory satisfies this structurally). Keeps
 *  memory-client free of any engine import — the engine is injected. */
export interface Engine {
  addMemory(input: MemoryInput): Promise<void>
  addEdge(input: EdgeInput): Promise<void>
  search(input: SearchInput): Promise<ReadonlyArray<SearchHit>>
  neighbors(id: string, opts?: { scopes?: readonly string[]; k?: number }): Promise<ReadonlyArray<Neighbor>>
  path(
    from: string,
    to: string,
    maxHops?: number,
    opts?: { scopes?: readonly string[] },
  ): Promise<PathResult | null>
  invalidate(id: string, at?: string, opts?: { scopes?: readonly string[] }): Promise<void>
  purge(id: string, opts?: { scopes?: readonly string[] }): Promise<void>
  moveScope(from: string, to: string): Promise<void>
  clearScope(scope: string): Promise<void>
  eraseAll(): Promise<number>
  discardLegacyGlobalExtracts(): Promise<number>
  stats(): Promise<Stats>
  list(input?: ListInput): Promise<ReadonlyArray<MemoryRow>>
  graph(input?: GraphInput): Promise<MemoryGraph>
}

/** Adapt an in-process engine (the WASM store) to the `MemoryClient` Interface: each op becomes an
 *  Effect, faults collapse to a tagged MemoryError so callers degrade. This is the in-process
 *  counterpart to `make` (which spoke HTTP to the retired Node sidecar). */
export const fromEngine = (engine: Engine): Interface => {
  const wrap = <A>(run: () => Promise<A>): Effect.Effect<A, MemoryError> =>
    Effect.tryPromise({ try: run, catch: (cause) => new MemoryError({ reason: String(cause).slice(0, 300) }) })
  return {
    health: () => Effect.succeed(true),
    addMemory: (input) => wrap(() => engine.addMemory(input)),
    addEdge: (input) => wrap(() => engine.addEdge(input)),
    search: (input) => wrap(() => engine.search(input)),
    // ⚠️ `access.scopes` is `undefined` ONLY for `owner`/`system`, and the engine reads that as "no
    // filter" — the same shape as before, but now it can only be reached by constructing an access
    // that says so out loud.
    neighbors: (id, access, opts) =>
      wrap(() => engine.neighbors(id, { ...(access.scopes ? { scopes: access.scopes } : {}), ...opts })),
    path: (from, to, access, maxHops) =>
      wrap(() => engine.path(from, to, maxHops, access.scopes ? { scopes: access.scopes } : {})),
    invalidate: (id, access, at) =>
      wrap(() => engine.invalidate(id, at, access.scopes ? { scopes: access.scopes } : {})),
    purge: (id, access) => wrap(() => engine.purge(id, access.scopes ? { scopes: access.scopes } : {})),
    moveScope: (from, to) => wrap(() => engine.moveScope(from, to)),
    clearScope: (scope) => wrap(() => engine.clearScope(scope)),
    eraseAll: () => wrap(() => engine.eraseAll()),
    discardLegacyGlobalExtracts: () => wrap(() => engine.discardLegacyGlobalExtracts()),
    stats: () => wrap(() => engine.stats()),
    list: (input) => wrap(() => engine.list(input)),
    graph: (input) => wrap(() => engine.graph(input)),
  }
}

/** A client that resolves its delegate per call — lets the boot hand over a live client immediately
 *  and swap the real engine in once it finishes opening in the background (ops degrade via the
 *  delegate — a `disabled` client — until then). `Effect.suspend` defers the lookup to run time. */
export const proxy = (get: () => Interface): Interface => ({
  health: () => Effect.suspend(() => get().health()),
  addMemory: (input) => Effect.suspend(() => get().addMemory(input)),
  addEdge: (input) => Effect.suspend(() => get().addEdge(input)),
  search: (input) => Effect.suspend(() => get().search(input)),
  neighbors: (id, access, opts) => Effect.suspend(() => get().neighbors(id, access, opts)),
  path: (from, to, access, maxHops) => Effect.suspend(() => get().path(from, to, access, maxHops)),
  invalidate: (id, access, at) => Effect.suspend(() => get().invalidate(id, access, at)),
  purge: (id, access) => Effect.suspend(() => get().purge(id, access)),
  moveScope: (from, to) => Effect.suspend(() => get().moveScope(from, to)),
  clearScope: (scope) => Effect.suspend(() => get().clearScope(scope)),
  eraseAll: () => Effect.suspend(() => get().eraseAll()),
  discardLegacyGlobalExtracts: () => Effect.suspend(() => get().discardLegacyGlobalExtracts()),
  stats: () => Effect.suspend(() => get().stats()),
  list: (input) => Effect.suspend(() => get().list(input)),
  graph: (input) => Effect.suspend(() => get().graph(input)),
})

/** Test/wiring seam: provide a specific client Interface (a live `make`, or a `stub`). */
export const layerWith = (client: Interface): Layer.Layer<Service> => Layer.succeed(Service, Service.of(client))

/** A degraded client for when memory can't run here (not configured, no Node, engine unavailable):
 *  health is false and every op fails with a clear MemoryError. So memory is never a HARD boot
 *  dependency — the instance comes up and callers degrade (the "never breaks" stance) instead of a
 *  missing engine bricking the app on a phone/cheap laptop. */
export const disabled = (reason = "memory is not available"): Interface => {
  const fail = <A>(): Effect.Effect<A, MemoryError> => Effect.fail(new MemoryError({ reason }))
  return {
    health: () => Effect.succeed(false),
    addMemory: fail,
    addEdge: fail,
    search: fail,
    neighbors: fail,
    path: fail,
    invalidate: fail,
    purge: fail,
    moveScope: fail,
    clearScope: fail,
    eraseAll: fail,
    discardLegacyGlobalExtracts: fail,
    stats: fail,
    list: fail,
    graph: fail,
  }
}

/** A deterministic in-memory client for downstream tests that don't want a real sidecar. Not a full
 *  graph engine — enough surface to exercise callers: add/search (substring + scope/kind filter),
 *  neighbors, invalidate/purge/clearScope, stats. Vector/FTS ranking is out of scope (that's the
 *  engine's job, covered by the sidecar's own node tests + the live smoke). */
export const stub = (): Interface => {
  const mems = new Map<string, MemoryRow & { valid: boolean }>()
  const edges: Array<{ from: string; to: string; type: string; scope: string }> = []
  const ok = <A>(a: A) => Effect.succeed(a)
  return {
    health: () => Effect.succeed(true),
    addMemory: (input) =>
      Effect.sync(() => {
        // FIDELITY: match the real engine on duplicate ids — MEASURED, a second addMemory with an
        // existing id neither throws nor overwrites; the engine keeps the ORIGINAL row (first write
        // wins). A stub that overwrote instead would be last-write-wins, so code relying on re-write
        // semantics could pass here and behave differently in production.
        if (mems.has(input.id)) return
        mems.set(input.id, {
          id: input.id,
          kind: input.kind,
          text: input.text,
          name: input.name ?? null,
          scope: input.scope,
          source: input.source ?? null,
          confidence: input.confidence ?? null,
          relation: input.relation ?? "staged",
          valid: true,
        })
      }),
    addEdge: (input) =>
      Effect.sync(() => void edges.push({ from: input.from, to: input.to, type: input.type, scope: input.scope })),
    search: (input) =>
      ok(
        [...mems.values()]
          .filter((m) => m.valid)
          .filter((m) => (input.scopes ? input.scopes.includes(m.scope) : true))
          .filter((m) => (input.kinds ? input.kinds.includes(m.kind) : true))
          .filter((m) =>
            input.query ? `${m.text} ${m.name ?? ""}`.toLowerCase().includes(input.query.toLowerCase()) : true,
          )
          .slice(0, input.k ?? 10)
          .map((m, i) => ({ ...stripValid(m), score: 1 / (i + 1) })),
      ),
    // 🔴 The double enforces the SAME rule as the engine, on the NODES. Its previous version filtered
    // the EDGE's scope and never looked at either endpoint — and a test asserted the resulting
    // cross-scope traversal as correct behaviour, which is how the leak came to be pinned rather than
    // caught. A double that is easier to satisfy than production is a test that certifies a bug.
    neighbors: (id, access, opts) => {
      const visible = (memoryID: string) => {
        const row = mems.get(memoryID)
        return row !== undefined && (access.scopes === undefined || access.scopes.includes(row.scope))
      }
      if (!visible(id)) return ok([])
      return ok(
        edges
          .filter((e) => e.from === id && visible(e.to))
          .slice(0, opts?.k ?? 25)
          .map((e) => ({ id: e.to, type: e.type, text: mems.get(e.to)?.text ?? "" })),
      )
    },
    path: (from, to, access) => {
      const visible = (memoryID: string) => {
        const row = mems.get(memoryID)
        return row !== undefined && (access.scopes === undefined || access.scopes.includes(row.scope))
      }
      if (!visible(from) || !visible(to)) return ok(null)
      return ok(edges.some((e) => e.from === from && e.to === to) ? { ids: [from, to], hops: 1 } : null)
    },
    invalidate: (id, access) =>
      Effect.sync(() => {
        const m = mems.get(id)
        if (m && (access.scopes === undefined || access.scopes.includes(m.scope))) m.valid = false
      }),
    purge: (id, access) =>
      Effect.sync(() => {
        const m = mems.get(id)
        if (m && (access.scopes === undefined || access.scopes.includes(m.scope))) mems.delete(id)
      }),
    moveScope: (from, to) =>
      Effect.sync(() => {
        // Re-inserted rather than mutated: the stub's rows are readonly, and a retirement's move must
        // keep the id (the engine does it with one `SET`, so the ids, vectors and edges survive).
        for (const [id, m] of [...mems]) if (m.scope === from) mems.set(id, { ...m, scope: to })
      }),
    clearScope: (scope) =>
      Effect.sync(() => {
        for (const [id, m] of mems) if (m.scope === scope) mems.delete(id)
      }),
    eraseAll: () =>
      Effect.sync(() => {
        const n = mems.size
        mems.clear()
        edges.length = 0
        return n
      }),
    discardLegacyGlobalExtracts: () =>
      Effect.sync(() => {
        let n = 0
        for (const [id, m] of [...mems])
          if (m.scope === "global" && m.source === "auto-extract") {
            mems.delete(id)
            n += 1
          }
        return n
      }),
    stats: () => ok({ total: mems.size, valid: [...mems.values()].filter((m) => m.valid).length }),
    list: (input) =>
      ok(
        [...mems.values()]
          .filter((m) => (input?.includeInvalid ? true : m.valid))
          .filter((m) => (input?.scopes ? input.scopes.includes(m.scope) : true))
          .filter((m) => (input?.kinds ? input.kinds.includes(m.kind) : true))
          .slice(input?.offset ?? 0, (input?.offset ?? 0) + (input?.limit ?? 200))
          .map(stripValid),
      ),
    graph: (input) => {
      const inScope = [...mems.values()]
        .filter((m) => m.valid)
        .filter((m) => (input?.scopes ? input.scopes.includes(m.scope) : true))
      const limit = input?.limit ?? 500
      const nodes = inScope.slice(0, limit).map(stripValid)
      const ids = new Set(nodes.map((n) => n.id))
      const graphEdges = edges
        .filter((e) => ids.has(e.from) && ids.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, type: e.type }))
      // ⚠️ The in-memory client keeps the newest-first truncation on purpose — it is a TEST double,
      // not a second implementation of the real engine's structure/recency split. What it must get
      // right is the CONTRACT: a truncated answer says `partial`, so a caller written against this
      // double cannot forget the field and pass against the real one.
      const partial = nodes.length < inScope.length
      return ok({
        nodes,
        edges: graphEdges,
        slice: {
          partial,
          total: inScope.length,
          returned: nodes.length,
          omitted: inScope.length - nodes.length,
          reason: partial ? ("connected-first" as const) : ("complete" as const),
        },
      })
    },
  }
}

const stripValid = (m: MemoryRow & { valid: boolean }): MemoryRow => {
  const { valid: _valid, ...row } = m
  return row
}
