import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// The graph-memory `/memory/*` endpoints (notes/kb-graph-plan.md §5, P5) — the read/edit surface
// the Memory settings tab + the (later) advanced viewer bind to.
//
// ⚠️ Base URL, auth, and fault decoding live in `utils/instance-fetch.ts`.
//
// The memory engine is a server-GLOBAL singleton (one graph per instance, like the SQLite DB), so
// `directory` here is only request routing (optional server-side; passed for parity with the other
// instance APIs). Read ops degrade to empty when memory is off/unavailable — the viewer shows
// "nothing remembered", never an error; write ops surface a 400 on a MemoryError.

// Wire types — mirror core kb-graph/memory-client (the client is the source of truth); the HTTP
// group (server/.../groups/memory.ts) re-declares the same shapes.
export interface MemoryRow {
  readonly id: string
  readonly kind: string
  readonly text: string
  readonly name: string | null
  readonly scope: string
  readonly source: string | null
  readonly confidence: number | null
  readonly relation: string
  // --- the claim lifecycle (P1). ---
  //
  // 🔴 These are not optional and they are not new on the wire: the server has been sending all
  // seven on every row since the claim lifecycle landed, and this interface simply did not name
  // them. That silence is what made the app's own "Incl. forgotten" toggle inert — a control that
  // could not have worked, filtering on a field the type said did not exist.
  //
  // ⚠️ A row that is not a claim still carries them: `status` is `active`, the identity columns are
  // null. So `status` is safe to read on every row, and the LENS is safe to apply to every row.
  /** `active` | `needs_review` | `superseded` | `archived` — see core `kb-graph/claim.ts`. */
  readonly status: string
  /** The claim's identity, when the harness accepted one. Null on a plain episode or passage. */
  readonly subject: string | null
  readonly predicate: string | null
  /** Set only for a `single`-cardinality predicate — the key a correction retires the priors by. */
  readonly conflictKey: string | null
  /** The claim that replaced this one. Non-null IS what "superseded" means, in one field. */
  readonly supersededBy: string | null
  /** Where the claim came from, as a locator the user can recognise (a path, a URL, a message). */
  readonly evidence: string | null
  /** What KIND of thing that locator is — `file`, `url`, … — so the panel can label it honestly. */
  readonly evidenceKind: string | null
}

export interface SearchHit extends MemoryRow {
  readonly score: number
}

export interface Neighbor {
  readonly id: string
  readonly type: string
  readonly text: string
}

export interface EdgeRow {
  readonly from: string
  readonly to: string
  readonly type: string
}

/**
 * How the server chose what it sent — mirrors `core/kb-graph/graph-slice.ts`.
 *
 * ⚠️ `partial` is not derivable here. "600 nodes came back" and "600 nodes exist" are the same bytes
 * from this side, so without the server saying so a viewer presents a corner of the map as the map.
 */
export interface GraphSlice {
  readonly partial: boolean
  readonly total: number
  readonly returned: number
  readonly omitted: number
  readonly reason: "complete" | "connected-first" | "scan-capped"
}

export interface MemoryGraph {
  readonly nodes: readonly MemoryRow[]
  readonly edges: readonly EdgeRow[]
  /** ⚠️ Optional on the WIRE only: an older instance predates the field. Absent = say nothing. */
  readonly slice?: GraphSlice
}

export interface MemoryStats {
  readonly total: number
  readonly valid: number
}

export type PathResult = { readonly ids: readonly string[]; readonly hops: number } | null

const call = <T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST",
  route: string,
  directory: string,
  body?: unknown,
  query?: Record<string, string | undefined>,
): Promise<T> => instanceFetch<T>(server, { method, route, directory, body, query })

const csv = (values: readonly string[] | undefined): string | undefined =>
  values && values.length ? values.join(",") : undefined

// --- reads (all degrade server-side; callers still .catch for transport faults) ---

export function memoryStats(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<MemoryStats>(server, "GET", "memory/stats", input.directory)
}

/**
 * Erase every memory in every scope, for every agent including Nova. Returns how many went.
 *
 * ⚠️ The CONFIRMATION is the caller's job and lives in the Settings control that offers this. A
 * helper that asked would put a dialog inside a fetch wrapper, and the next caller would either get a
 * surprise modal or route around it.
 */
export function memoryErase(server: ServerConnection.HttpBase, input: { directory: string }) {
  // ⚠️ `api/memory/erase`, not `memory/erase`: the rest of this file talks to the LEGACY `/memory/*`
  // surface, which ruling 11 freezes — new endpoints go on the one contract under `/api/*`, and
  // `sdk/js/test/legacy-path-ledger.test.ts` turns red if one is added beside its old neighbours.
  return call<number>(server, "POST", "api/memory/erase", input.directory)
}

export function memoryList(
  server: ServerConnection.HttpBase,
  input: {
    directory: string
    scopes?: readonly string[]
    kinds?: readonly string[]
    /**
     * THE LIFECYCLE LENS — a status set the SERVER filters by.
     *
     * ⚠️ **Unset means EVERY status, history included**, which is the opposite of the default a
     * reader expects and is why it is spelled out here rather than left to the endpoint's docs. The
     * surfaces that want current truth pass it explicitly (`utils/memory-lens.ts`); a caller
     * that omits it is asking for the whole record and gets it.
     */
    statuses?: readonly string[]
    includeInvalid?: boolean
    limit?: number
    offset?: number
  },
) {
  const scopes = csv(input.scopes)
  const kinds = csv(input.kinds)
  return call<MemoryRow[]>(server, "GET", "memory/list", input.directory, undefined, {
    scopes,
    kinds,
    statuses: csv(input.statuses),
    includeInvalid: input.includeInvalid ? "1" : undefined,
    limit: input.limit === undefined ? undefined : String(input.limit),
    offset: input.offset === undefined ? undefined : String(input.offset),
  })
}

export function memoryGraph(
  server: ServerConnection.HttpBase,
  input: { directory: string; scopes?: readonly string[]; limit?: number },
) {
  const scopes = csv(input.scopes)
  return call<MemoryGraph>(server, "GET", "memory/graph", input.directory, undefined, {
    scopes,
    limit: input.limit === undefined ? undefined : String(input.limit),
  })
}

export function memorySearch(
  server: ServerConnection.HttpBase,
  input: { directory: string; query: string; k?: number; scopes?: readonly string[]; kinds?: readonly string[] },
) {
  return call<SearchHit[]>(server, "POST", "memory/search", input.directory, {
    query: input.query,
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.scopes ? { scopes: input.scopes } : {}),
    ...(input.kinds ? { kinds: input.kinds } : {}),
  })
}

export function memoryNeighbors(
  server: ServerConnection.HttpBase,
  input: { directory: string; id: string; k?: number },
) {
  return call<Neighbor[]>(server, "POST", "memory/neighbors", input.directory, {
    id: input.id,
    ...(input.k !== undefined ? { k: input.k } : {}),
  })
}

export function memoryPath(
  server: ServerConnection.HttpBase,
  input: { directory: string; from: string; to: string; maxHops?: number },
) {
  return call<PathResult>(server, "POST", "memory/path", input.directory, {
    from: input.from,
    to: input.to,
    ...(input.maxHops !== undefined ? { maxHops: input.maxHops } : {}),
  })
}

// --- writes (surface a 400 on a MemoryError → the caller toasts) ---

export function memoryRemember(
  server: ServerConnection.HttpBase,
  input: { directory: string; text: string; name?: string; scope: string; kind?: string },
) {
  return call<{ id: string }>(server, "POST", "memory/remember", input.directory, {
    text: input.text,
    ...(input.name !== undefined ? { name: input.name } : {}),
    scope: input.scope,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
  })
}

export function memoryInvalidate(server: ServerConnection.HttpBase, input: { directory: string; id: string }) {
  return call<boolean>(server, "POST", "memory/invalidate", input.directory, { id: input.id })
}

export function memoryPurge(server: ServerConnection.HttpBase, input: { directory: string; id: string }) {
  return call<boolean>(server, "POST", "memory/purge", input.directory, { id: input.id })
}

export function memoryIngest(
  server: ServerConnection.HttpBase,
  input: { directory: string; text: string; name: string; scope?: string },
) {
  return call<{ stored: number; passages: number }>(server, "POST", "memory/ingest", input.directory, {
    text: input.text,
    name: input.name,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  })
}

export function memoryClearScope(server: ServerConnection.HttpBase, input: { directory: string; scope: string }) {
  return call<boolean>(server, "POST", "memory/clearScope", input.directory, { scope: input.scope })
}
