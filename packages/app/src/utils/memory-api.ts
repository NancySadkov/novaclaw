import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Raw-fetch helpers for the graph-memory `/memory/*` endpoints (notes/kb-graph-plan.md §5, P5) —
// the read/edit surface the Memory settings tab + the (later) advanced viewer bind to. NOT in the
// generated SDK (golden rule: never hand-edit packages/sdk/**/gen/**) — plain fetch with the
// createSdkForServer auth recipe, exactly like registry-api.ts / fs-api.ts.
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

export interface MemoryGraph {
  readonly nodes: readonly MemoryRow[]
  readonly edges: readonly EdgeRow[]
}

export interface MemoryStats {
  readonly total: number
  readonly valid: number
}

export type PathResult = { readonly ids: readonly string[]; readonly hops: number } | null

function headersFor(server: ServerConnection.HttpBase): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {}),
  }
}

async function call<T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST",
  route: string,
  directory: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(route, server.url.endsWith("/") ? server.url : `${server.url}/`)
  url.searchParams.set("directory", directory)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  const res = await fetch(url, {
    method,
    headers: headersFor(server),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as T
}

const csv = (values: readonly string[] | undefined): string | undefined =>
  values && values.length ? values.join(",") : undefined

// --- reads (all degrade server-side; callers still .catch for transport faults) ---

export function memoryStats(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<MemoryStats>(server, "GET", "memory/stats", input.directory)
}

export function memoryList(
  server: ServerConnection.HttpBase,
  input: {
    directory: string
    scopes?: readonly string[]
    kinds?: readonly string[]
    includeInvalid?: boolean
    limit?: number
    offset?: number
  },
) {
  const scopes = csv(input.scopes)
  const kinds = csv(input.kinds)
  return call<MemoryRow[]>(server, "GET", "memory/list", input.directory, undefined, {
    ...(scopes ? { scopes } : {}),
    ...(kinds ? { kinds } : {}),
    ...(input.includeInvalid ? { includeInvalid: "1" } : {}),
    ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
    ...(input.offset !== undefined ? { offset: String(input.offset) } : {}),
  })
}

export function memoryGraph(
  server: ServerConnection.HttpBase,
  input: { directory: string; scopes?: readonly string[]; limit?: number },
) {
  const scopes = csv(input.scopes)
  return call<MemoryGraph>(server, "GET", "memory/graph", input.directory, undefined, {
    ...(scopes ? { scopes } : {}),
    ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
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
