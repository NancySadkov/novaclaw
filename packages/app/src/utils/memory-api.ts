import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// The graph-memory `/memory/*` endpoints — the read/edit surface
// the Memory settings tab + the (later) advanced viewer bind to.
//
// ⚠️ Base URL, auth, and fault decoding live in `utils/instance-fetch.ts`.
//
// The memory engine is a server-GLOBAL singleton (one graph per instance, like the SQLite DB), so
// `directory` here is only request routing. Read failures reject: the atlas carries that failure as
// an explicit unavailable state, because an outage and an empty cabinet are different facts.

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

export interface AtlasCaptions {
  readonly status: "generated" | "partial" | "unavailable"
  readonly clusters: readonly { readonly id: string; readonly label: string }[]
  readonly memories: readonly { readonly id: string; readonly label: string }[]
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

/**
 * Erase every memory in every scope, for every agent including Nova. Returns how many went.
 *
 * ⚠️ The CONFIRMATION is the caller's job and lives in the Settings control that offers this. A
 * helper that asked would put a dialog inside a fetch wrapper, and the next caller would either get a
 * surprise modal or route around it.
 */
export function worldMemoryErase(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<number>(server, "POST", "api/world-memory/erase", input.directory)
}

export async function worldMemoryEraseVerified(server: ServerConnection.HttpBase, input: { directory: string }) {
  const erased = await worldMemoryErase(server, input)
  const remaining = await worldMemoryList(server, { ...input, includeInvalid: true, limit: 1 })
  if (remaining.length > 0) throw new Error("Agent memory erase left rows in the store")
  return erased
}

/**
 * Fetch the complete backup view. Pagination is exhausted by the server so this result is atomic at
 * the HTTP boundary: a page fault rejects instead of handing the caller a plausible partial array.
 */
/**
 * Erase and then prove the authoritative store is empty. A successful count with rows left behind
 * is not a successful clear, and a failed verification must not become a success toast.
 */
/**
 * The access ledger's verdict on one memory (P3). Optional on an item: a row nothing has ever
 * touched has no counters, and inventing zeroes would make "never recalled" and "recalled and
 * discarded" the same row.
 */
export interface UsageCounts {
  readonly accesses: number
  readonly uses: number
  readonly useful: number
  readonly corrections: number
  readonly firstAccessedAt: number
  readonly lastAccessedAt: number
}

export interface UsageItem extends MemoryRow {
  readonly usage?: UsageCounts
}

/**
 * ⚠️ `scanned`/`partial` for the same reason `GraphSlice` exists: "twelve never-used memories came
 * back" and "twelve never-used memories exist" are identical bytes from this side, and a viewer
 * without the distinction presents a corner of the answer as the whole of it.
 */
export interface NeverUsedResult {
  readonly items: readonly UsageItem[]
  readonly scanned: number
  readonly partial: boolean
}

/**
 * ─── THE NOISE VIEWS, ON THE ONE CONTRACT ────────────────────────────────────────────────────────
 *
 * ⚠️ **POST for a read.** `scopes` carries `session:<id>`, which is `correlate`-class data that may
 * not egress, and a query string lands in access logs, proxy logs and referrers. Same shape and same
 * reason as `POST /api/log/read`; no `/api/*` group declares `urlParams`.
 */

/** Memories no recall has ever returned, oldest first — the `Never used` lens's data source. */
export function memoryNeverUsed(
  server: ServerConnection.HttpBase,
  input: { directory: string; scopes?: readonly string[]; limit?: number; scan?: number },
) {
  return call<NeverUsedResult>(server, "POST", "api/memory/usage/never-used", input.directory, {
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.scan === undefined ? {} : { scan: input.scan }),
  })
}

/** Memories somebody vouched for — the `Vouched for` lens. These are never pruned. */
export function memoryUseful(
  server: ServerConnection.HttpBase,
  input: { directory: string; scopes?: readonly string[]; limit?: number },
) {
  return call<{ items: readonly UsageItem[] }>(server, "POST", "api/memory/usage/useful", input.directory, {
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })
}

/**
 * One question whose recalled answers keep being corrected.
 *
 * ⚠️ Grouped by claim IDENTITY, not by claim — a single claim is superseded at most once, so
 * "repeatedly" can only ever be a property of the question.
 */
export interface CorrectionGroup {
  readonly conflictKey: string
  readonly scope: string
  readonly corrected: number
  readonly corrections: number
  readonly lastAccessedAt: number
  readonly items: readonly UsageItem[]
}

export function memoryCorrectionProne(
  server: ServerConnection.HttpBase,
  input: { directory: string; minCorrected?: number; limit?: number },
) {
  return call<{ groups: readonly CorrectionGroup[] }>(server, "POST", "api/memory/usage/corrections", input.directory, {
    ...(input.minCorrected === undefined ? {} : { minCorrected: input.minCorrected }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })
}

/** One recall that returned a memory. The query is a FINGERPRINT and never the words. */
export interface UsageAccess {
  readonly fingerprint: string
  readonly surface: string
  readonly rank: number
  readonly score: number
  readonly accessedAt: number
  readonly usedAt: number | null
  readonly usefulAt: number | null
  readonly correctedAt: number | null
}

/** "Why is this here" — every recall that returned one memory, and what became of each. */
export function memoryUsageDetail(server: ServerConnection.HttpBase, input: { directory: string; id: string }) {
  return call<{ usage: UsageCounts | null; accesses: readonly UsageAccess[] }>(
    server,
    "POST",
    "api/memory/usage/detail",
    input.directory,
    { id: input.id },
  )
}

/**
 * Vouch for a memory, or retract the vouch.
 *
 * ⚠️ `false` RETRACTS rather than counting a negative. The flag exists to PROTECT — a vouched memory
 * is excluded from the forgetting pass outright — so the only two states that matter are "somebody
 * vouched" and "nobody did".
 */
/** Explicit, complete answers for the requested ids; a capped useful list cannot answer this. */
export async function memoryProtection(
  server: ServerConnection.HttpBase,
  input: { directory: string; ids: readonly string[] },
) {
  const result = new Map<string, boolean>()
  const ids = [...new Set(input.ids)]
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500)
    const rows = await call<{ id: string; protected: boolean }[]>(
      server,
      "POST",
      "api/memory/protection",
      input.directory,
      { ids: batch },
    )
    for (const row of rows) {
      if (typeof row.protected !== "boolean") throw new Error("Invalid memory protection state")
      result.set(row.id, row.protected)
    }
    if (batch.some((id) => !result.has(id))) throw new Error("Incomplete memory protection state")
  }
  return result
}

/** Read an officer-owned RAG component or the household's shared component. */
export function worldMemoryList(
  server: ServerConnection.HttpBase,
  input: {
    directory: string
    scopes?: readonly string[]
    kinds?: readonly string[]
    statuses?: readonly string[]
    includeInvalid?: boolean
    limit?: number
    offset?: number
  },
) {
  const { directory, ...payload } = input
  return call<MemoryRow[]>(server, "POST", "api/world-memory/list", directory, payload)
}

export function worldMemoryGraph(
  server: ServerConnection.HttpBase,
  input: { directory: string; scopes?: readonly string[]; limit?: number },
) {
  const { directory, ...payload } = input
  return call<MemoryGraph>(server, "POST", "api/world-memory/graph", directory, payload)
}

/** Generate presentation-only map labels through the cabinet owner's normal local model. */
export function worldMemoryCaptions(
  server: ServerConnection.HttpBase,
  input: {
    directory: string
    scope: string
    clusters: readonly { readonly id: string; readonly ids: readonly string[] }[]
    memories: readonly string[]
  },
) {
  const { directory, ...payload } = input
  return call<AtlasCaptions>(server, "POST", "api/world-memory/captions", directory, payload)
}

async function worldMemoryClearScope(server: ServerConnection.HttpBase, input: { directory: string; scope: string }) {
  return call<boolean>(server, "POST", "api/world-memory/clear-scope", input.directory, { scope: input.scope })
}

/** Clear one officer cabinet and prove that even invalidated rows are gone. */
export async function worldMemoryClearScopeVerified(
  server: ServerConnection.HttpBase,
  input: { directory: string; scope: string },
) {
  const cleared = await worldMemoryClearScope(server, input)
  if (!cleared) throw new Error(`Agent memory scope ${input.scope} was not cleared`)
  const remaining = await worldMemoryList(server, {
    directory: input.directory,
    scopes: [input.scope],
    includeInvalid: true,
    limit: 1,
  })
  if (remaining.length > 0) throw new Error(`Agent memory scope ${input.scope} still contains memories`)
}

export function worldMemoryInvalidate(server: ServerConnection.HttpBase, input: { directory: string; id: string }) {
  return call<boolean>(server, "POST", "api/world-memory/invalidate", input.directory, { id: input.id })
}

export function worldMemoryClaimStatus(
  server: ServerConnection.HttpBase,
  input: { directory: string; id: string; status: PersonClaimStatus },
) {
  return call<boolean>(server, "POST", "api/world-memory/claim/status", input.directory, {
    id: input.id,
    status: input.status,
  })
}

export function worldMemoryFeedback(
  server: ServerConnection.HttpBase,
  input: { directory: string; id: string; useful: boolean },
) {
  return call<boolean>(server, "POST", "api/world-memory/feedback", input.directory, {
    id: input.id,
    useful: input.useful,
  })
}

// --- the claim lifecycle, on the ONE contract (`/api/*`) ---

/** The statuses a PERSON controls. `superseded` is the lifecycle's own and is not settable. */
export type PersonClaimStatus = "active" | "archived" | "needs_review"

/**
 * Archive, restore or flag one claim.
 *
 * ⚠️ Answers whether the status actually MOVED. `false` is a real answer — the claim is gone, or it
 * was already in that state — and a caller that drew a lifecycle change on `false` would be showing
 * the user something that did not happen.
 */
export interface ClaimEvidence {
  readonly kind: "chat" | "message" | "passage" | "file" | "url" | "test" | "command" | "commit"
  readonly locator: string
  readonly label?: string
}

export interface ClaimWriteResult {
  readonly ok: boolean
  readonly id?: string
  readonly status?: string
  /** Did the store accept a conflict identity? `false` = this claim corrects nothing, by design. */
  readonly identified?: boolean
  readonly deduped?: boolean
  /** What this claim RETIRED. Empty is the common case; non-empty is a correction. */
  readonly superseded: readonly string[]
  readonly reason?: string
}

/**
 * Record a governed claim — the only write on the HTTP surface that can CORRECT anything.
 *
 * `memory/remember` writes a plain node with no subject or predicate, so nothing it creates can ever
 * be superseded. Naming a subject and a predicate is what makes this claim the answer to a question,
 * and what lets the next one replace it.
 */
export function memoryAddClaim(
  server: ServerConnection.HttpBase,
  input: {
    directory: string
    statement: string
    scope?: string
    subject?: string
    predicate?: string
    confidence?: number
    source?: string
    validFrom?: string
    evidence?: readonly ClaimEvidence[]
  },
) {
  const { directory, ...body } = input
  return call<ClaimWriteResult>(server, "POST", "api/memory/claim", directory, body)
}
