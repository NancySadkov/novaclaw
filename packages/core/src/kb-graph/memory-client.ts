export * as MemoryClient from "./memory-client"

import { Context, Effect, Layer, Schema } from "effect"

// The Bun-side client to the Ladybug graph-memory sidecar (notes/kb-graph-plan.md §2.1). The engine
// runs as a supervised NODE process (the native @ladybugdb/core addon segfaults under Bun — P0); the
// Bun kernel reaches it over LOOPBACK HTTP only (never egresses — OFF-C). This is a thin, dumb HTTP
// client: one POST per op, mirroring the sidecar routes in `@novaclaw/kb-sidecar/server`. No process
// management here (the supervisor in ./sidecar.ts owns spawn + restart); no config reads (the caller
// passes the resolved base url + bearer token the supervisor learned at boot). Errors collapse to a
// single tagged MemoryError so callers can DEGRADE gracefully (memory down ≠ turn fails) — the same
// "degrade, never break" stance as the KB-V embedder.
//
// ⚠️ Wire-contract types are DUPLICATED from the sidecar's `store.ts` on purpose: core (Bun) must not
// import the sidecar package at runtime (it loads @ladybugdb/core → segfault). The HTTP boundary IS
// the contract; the live spawn smoke (memory-client-live.smoke.ts) is the contract test that keeps the
// two in sync against the REAL engine. Keep these in lock-step with kb-sidecar/src/store.ts.

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
}

export interface Options {
  /** Loopback base URL, e.g. `http://127.0.0.1:54123` (no trailing slash needed). A THUNK is
   *  allowed so the supervisor can hand a moving target: the sidecar binds port 0 (OS-assigned), so
   *  every restart lands on a NEW port — the thunk reads the current one per call, and returns "" while
   *  the sidecar is down (ops then fail fast as MemoryError → callers degrade). */
  readonly url: string | (() => string)
  /** Shared bearer token the sidecar requires on every route but /health. */
  readonly token?: string
  /** Per-request budget. Memory ops are async/off-hot-path, so this is generous. */
  readonly timeoutMs?: number
}

/** The live HTTP client to a running sidecar at `url`. */
export const make = (options: Options): Interface => {
  const resolveBase = typeof options.url === "function" ? options.url : () => options.url as string
  const timeoutMs = options.timeoutMs ?? 30_000
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  }

  const post = <T>(path: string, body: unknown): Effect.Effect<T, MemoryError> =>
    Effect.tryPromise({
      try: async () => {
        const base = resolveBase().replace(/\/+$/, "")
        if (!base) throw new Error("memory sidecar unavailable (no listening url)")
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
          // The sidecar returns { error } on 4xx/5xx — surface it (truncated) for diagnosis.
          const detail = await response
            .json()
            .then((b) => (b && typeof b === "object" && "error" in b ? String((b as { error: unknown }).error) : ""))
            .catch(() => "")
          throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
        }
        return (await response.json()) as T
      },
      catch: (cause) => new MemoryError({ reason: String(cause).slice(0, 300) }),
    })

  return {
    health: () =>
      Effect.tryPromise(async () => {
        const base = resolveBase().replace(/\/+$/, "")
        if (!base) return false
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
        return response.ok
      }).pipe(Effect.orElseSucceed(() => false)),
    addMemory: (input) => post<{ ok: boolean }>("/add", input).pipe(Effect.asVoid),
    addEdge: (input) => post<{ ok: boolean }>("/addEdge", input).pipe(Effect.asVoid),
    search: (input) => post<{ hits: SearchHit[] }>("/search", input).pipe(Effect.map((r) => r.hits)),
    neighbors: (id, opts) =>
      post<{ neighbors: Neighbor[] }>("/neighbors", {
        id,
        ...(opts?.scopes ? { scopes: opts.scopes } : {}),
        ...(opts?.k === undefined ? {} : { k: opts.k }),
      }).pipe(Effect.map((r) => r.neighbors)),
    path: (from, to, maxHops) =>
      post<{ path: PathResult | null }>("/path", {
        from,
        to,
        ...(maxHops === undefined ? {} : { maxHops }),
      }).pipe(Effect.map((r) => r.path)),
    invalidate: (id, at) =>
      post<{ ok: boolean }>("/invalidate", { id, ...(at === undefined ? {} : { at }) }).pipe(Effect.asVoid),
    purge: (id) => post<{ ok: boolean }>("/purge", { id }).pipe(Effect.asVoid),
    clearScope: (scope) => post<{ ok: boolean }>("/clearScope", { scope }).pipe(Effect.asVoid),
    stats: () => post<{ stats: Stats }>("/stats", {}).pipe(Effect.map((r) => r.stats)),
  }
}

// The Effect service tag — the memory tier the kb tool + auto-recall/extract hooks depend on. The
// instance-boot layer spawns + supervises the sidecar (./sidecar.ts) and provides the live client;
// tests provide a client over a stub server (or the in-memory `stub`) via `layerWith`.
export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MemoryClient") {}

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
  }
}

const stripValid = (m: MemoryRow & { valid: boolean }): MemoryRow => {
  const { valid: _valid, ...row } = m
  return row
}
