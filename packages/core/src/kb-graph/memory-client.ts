export * as MemoryClient from "./memory-client"

import { Context, Effect, Layer, Schema } from "effect"

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

export interface MemoryGraph {
  readonly nodes: ReadonlyArray<MemoryRow>
  readonly edges: ReadonlyArray<EdgeRow>
}

export interface Interface {
  /** Liveness probe — never fails (returns false if the sidecar is unreachable). */
  readonly health: () => Effect.Effect<boolean>
  readonly addMemory: (input: MemoryInput) => Effect.Effect<void, MemoryError>
  readonly addEdge: (input: EdgeInput) => Effect.Effect<void, MemoryError>
  readonly search: (input: SearchInput) => Effect.Effect<ReadonlyArray<SearchHit>, MemoryError>
  readonly neighbors: (
    id: string,
    opts?: { scopes?: readonly string[]; k?: number },
  ) => Effect.Effect<ReadonlyArray<Neighbor>, MemoryError>
  readonly path: (from: string, to: string, maxHops?: number) => Effect.Effect<PathResult | null, MemoryError>
  readonly invalidate: (id: string, at?: string) => Effect.Effect<void, MemoryError>
  readonly purge: (id: string) => Effect.Effect<void, MemoryError>
  readonly clearScope: (scope: string) => Effect.Effect<void, MemoryError>
  readonly stats: () => Effect.Effect<Stats, MemoryError>
  /** Enumerate memories (viewer/editor) — no query, newest first, filterable + paginated. */
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<MemoryRow>, MemoryError>
  /** The graph slice for the visualizer: nodes + the edges among them. */
  readonly graph: (input?: GraphInput) => Effect.Effect<MemoryGraph, MemoryError>
}

// The Effect service tag — the memory tier the kb tool + auto-recall/extract hooks depend on. The
// instance-boot layer (Memory.node) opens the in-process WASM engine and provides the live client via
// `fromEngine`; tests provide a client via `stub`/`disabled` through `layerWith`.
export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MemoryClient") {}

/** The in-process engine surface the client adapts (WasmMemory satisfies this structurally). Keeps
 *  memory-client free of any engine import — the engine is injected. */
export interface Engine {
  addMemory(input: MemoryInput): Promise<void>
  addEdge(input: EdgeInput): Promise<void>
  search(input: SearchInput): Promise<ReadonlyArray<SearchHit>>
  neighbors(id: string, opts?: { scopes?: readonly string[]; k?: number }): Promise<ReadonlyArray<Neighbor>>
  path(from: string, to: string, maxHops?: number): Promise<PathResult | null>
  invalidate(id: string, at?: string): Promise<void>
  purge(id: string): Promise<void>
  clearScope(scope: string): Promise<void>
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
    neighbors: (id, opts) => wrap(() => engine.neighbors(id, opts)),
    path: (from, to, maxHops) => wrap(() => engine.path(from, to, maxHops)),
    invalidate: (id, at) => wrap(() => engine.invalidate(id, at)),
    purge: (id) => wrap(() => engine.purge(id)),
    clearScope: (scope) => wrap(() => engine.clearScope(scope)),
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
  neighbors: (id, opts) => Effect.suspend(() => get().neighbors(id, opts)),
  path: (from, to, maxHops) => Effect.suspend(() => get().path(from, to, maxHops)),
  invalidate: (id, at) => Effect.suspend(() => get().invalidate(id, at)),
  purge: (id) => Effect.suspend(() => get().purge(id)),
  clearScope: (scope) => Effect.suspend(() => get().clearScope(scope)),
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
    clearScope: fail,
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
    addEdge: (input) => Effect.sync(() => void edges.push({ from: input.from, to: input.to, type: input.type, scope: input.scope })),
    search: (input) =>
      ok(
        [...mems.values()]
          .filter((m) => m.valid)
          .filter((m) => (input.scopes ? input.scopes.includes(m.scope) : true))
          .filter((m) => (input.kinds ? input.kinds.includes(m.kind) : true))
          .filter((m) => (input.query ? `${m.text} ${m.name ?? ""}`.toLowerCase().includes(input.query.toLowerCase()) : true))
          .slice(0, input.k ?? 10)
          .map((m, i) => ({ ...stripValid(m), score: 1 / (i + 1) })),
      ),
    neighbors: (id, opts) =>
      ok(
        edges
          .filter((e) => e.from === id && (opts?.scopes ? opts.scopes.includes(e.scope) : true))
          .slice(0, opts?.k ?? 25)
          .map((e) => ({ id: e.to, type: e.type, text: mems.get(e.to)?.text ?? "" })),
      ),
    path: (from, to) => ok(edges.some((e) => e.from === from && e.to === to) ? { ids: [from, to], hops: 1 } : null),
    invalidate: (id) =>
      Effect.sync(() => {
        const m = mems.get(id)
        if (m) m.valid = false
      }),
    purge: (id) => Effect.sync(() => void mems.delete(id)),
    clearScope: (scope) =>
      Effect.sync(() => {
        for (const [id, m] of mems) if (m.scope === scope) mems.delete(id)
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
      const nodes = [...mems.values()]
        .filter((m) => m.valid)
        .filter((m) => (input?.scopes ? input.scopes.includes(m.scope) : true))
        .slice(0, input?.limit ?? 500)
        .map(stripValid)
      const ids = new Set(nodes.map((n) => n.id))
      const graphEdges = edges
        .filter((e) => ids.has(e.from) && ids.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, type: e.type }))
      return ok({ nodes, edges: graphEdges })
    },
  }
}

const stripValid = (m: MemoryRow & { valid: boolean }): MemoryRow => {
  const { valid: _valid, ...row } = m
  return row
}
