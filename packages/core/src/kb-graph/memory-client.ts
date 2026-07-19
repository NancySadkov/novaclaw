export * as MemoryClient from "./memory-client"

import { Effect, Schema } from "effect"

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
  /** Loopback base URL, e.g. `http://127.0.0.1:54123` (no trailing slash needed). */
  readonly url: string
  /** Shared bearer token the sidecar requires on every route but /health. */
  readonly token?: string
  /** Per-request budget. Memory ops are async/off-hot-path, so this is generous. */
  readonly timeoutMs?: number
}

/** The live HTTP client to a running sidecar at `url`. */
export const make = (options: Options): Interface => {
  const base = options.url.replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? 30_000
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  }

  const post = <T>(path: string, body: unknown): Effect.Effect<T, MemoryError> =>
    Effect.tryPromise({
      try: async () => {
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
