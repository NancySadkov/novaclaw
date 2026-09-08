export * as MemoryClient from "./memory-client"

import { Context, Effect, Layer, Schema } from "effect"
import { KbChunk } from "./chunk"
import { KbClaim } from "./claim"
import { compatible, narrowest, type MemoryAccess } from "./memory-access"

// The memory tier's Effect-facing surface: the `Interface` the kb tool +
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

export type MemoryKind = "entity" | "episode" | "passage" | "claim" | "source"
export type Relation = "staged" | "core"
export type ClaimStatus = KbClaim.ClaimStatus
export type EvidenceKind = KbClaim.EvidenceKind

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
  readonly status?: ClaimStatus
  readonly subject?: string
  readonly predicate?: string
  readonly conflictKey?: string
  readonly evidence?: string
  readonly evidenceKind?: EvidenceKind
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
  /** Lifecycle statuses to return. Defaults to CURRENT TRUTH — see `KbClaim.RECALL_STATUSES`. */
  readonly statuses?: readonly ClaimStatus[]
  /**
   * Who is asking, for the activity feed and the P3 access ledger.
   *
   * The store cannot infer this: auto-recall, a model's `kb search` and the Memory app's own search
   * box arrive as the same call. It rides on the INPUT rather than as a second argument so it
   * survives the `proxy`/`client`/`observed` indirections without changing four signatures, and an
   * omitted value records `unknown` instead of guessing.
   */
  readonly surface?: "auto-recall" | "kb-tool" | "http" | "unknown"
  /**
   * Correlates this recall's ledger rows with the consumer's later "these actually reached the
   * model" report (P3).
   *
   * ⚠️ The CALLER mints it, and that is the point: the store writes one ledger row per returned
   * memory and then hands the pool back, but only the consumer knows which of them survived its
   * context budget. Without a shared id the consumer would have to guess which rows it just caused —
   * "the newest ones for these ids" — which is wrong the moment two sessions recall at once. Absent
   * means nobody will report back, and the store mints a private id so the rows still group.
   */
  readonly recallID?: string
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
  readonly status: ClaimStatus
  readonly subject: string | null
  readonly predicate: string | null
  readonly conflictKey: string | null
  readonly supersededBy: string | null
  readonly evidence: string | null
  readonly evidenceKind: EvidenceKind | null
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

/**
 * What `candidates` selects: a memory described by everything EXCEPT its body.
 *
 * 🔴 The projection carries NO long text on purpose. A table scan on the shipping engine can return
 * an empty string for `text` while the row is intact, so a policy or a noise view that scanned for
 * bodies would silently work with blanks. `byIds` hydrates the handful the caller actually chose.
 */
export interface CandidateInput {
  readonly scopes?: readonly string[]
  readonly kinds?: readonly MemoryKind[]
  readonly statuses?: readonly ClaimStatus[]
  readonly relation?: Relation
  readonly includeInvalid?: boolean
  /** `oldest` (the default) is what "never used, oldest first" and the prune policy both want. */
  readonly order?: "oldest" | "newest"
  readonly limit?: number
}

export interface CandidateRow {
  readonly id: string
  readonly scope: string
  readonly kind: MemoryKind
  readonly name: string | null
  readonly source: string | null
  readonly confidence: number | null
  readonly relation: Relation
  readonly status: ClaimStatus
  readonly conflictKey: string | null
  /** ISO, when the engine had one. Absent rather than faked. */
  readonly createdAt?: string
}

export interface ListInput {
  readonly scopes?: readonly string[]
  readonly kinds?: readonly MemoryKind[]
  readonly includeInvalid?: boolean
  /** Lifecycle lens for the Memory app. Unset = every status, history included. */
  readonly statuses?: readonly ClaimStatus[]
  readonly limit?: number
  readonly offset?: number
}

/** What a caller asks the lifecycle to record — every identity field is a PROPOSAL until validated. */
export interface ClaimInput {
  readonly scope: string
  readonly statement: string
  readonly subject?: string
  readonly predicate?: string
  readonly confidence?: number
  readonly relation?: Relation
  readonly source?: string
  readonly agent?: string
  readonly embedding?: readonly number[]
  readonly validFrom?: string
  readonly evidence?: readonly KbClaim.Evidence[]
}

export interface ClaimResult {
  readonly ok: boolean
  readonly id?: string
  readonly status?: ClaimStatus
  /** Did the harness accept a conflict identity? `false` = this claim corrects nothing, by design. */
  readonly identified?: boolean
  readonly deduped?: boolean
  readonly superseded: readonly string[]
  readonly reason?: "empty" | "refused-scope" | "too-many-revisions"
}

export interface EvidenceRow {
  readonly claimID: string
  readonly id: string
  readonly kind: EvidenceKind
  readonly locator: string
  readonly label: string
}

export interface ClaimHistory {
  readonly claim: MemoryRow
  /** The claim that answers this question NOW, when the one asked for has been replaced. */
  readonly current: MemoryRow | null
  readonly timeline: ReadonlyArray<MemoryRow>
  readonly evidence: ReadonlyArray<EvidenceRow>
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
  /**
   * ⚠️ Returns WHETHER it happened, and at what scope. A relation can now be REFUSED — endpoints in
   * two different private spaces have no scope that contains both — and a refusal that looked like a
   * success is how a model comes to believe a graph that is not there.
   */
  readonly addEdge: (input: EdgeInput, access: MemoryAccess) => Effect.Effect<EdgeResult, MemoryError>
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
  /** Read one current row by storage key, with the same mandatory scope guard as traversal. */
  readonly get: (id: string, access: MemoryAccess) => Effect.Effect<MemoryRow | null, MemoryError>
  readonly path: (
    from: string,
    to: string,
    access: MemoryAccess,
    maxHops?: number,
  ) => Effect.Effect<PathResult | null, MemoryError>
  readonly invalidate: (id: string, access: MemoryAccess, at?: string) => Effect.Effect<void, MemoryError>
  readonly purge: (id: string, access: MemoryAccess) => Effect.Effect<void, MemoryError>
  /**
   * 🔴 Record a governed claim: write it, file it against its subject and its evidence, and retire the
   * claim it corrects — all under one lock.
   *
   * `access` is REQUIRED for the same reason it is on the read side, and the write direction is the
   * one the lifecycle newly exposes: supersession is keyed on `scope + subject + predicate`, so a
   * caller that could name any scope could retire another chat's current answer WITHOUT ever knowing
   * its id. A scope outside the caller's reach comes back `ok: false, reason: "refused-scope"`.
   */
  readonly addClaim: (input: ClaimInput, access: MemoryAccess) => Effect.Effect<ClaimResult, MemoryError>
  /** The timeline and the explanation. `null` when the claim does not exist OR is out of reach — the
   *  same answer for both, so an id cannot be probed for existence. */
  readonly claimHistory: (id: string, access: MemoryAccess) => Effect.Effect<ClaimHistory | null, MemoryError>
  /** The cited evidence moved: flag every claim resting on `locator` as `needs_review`. Returns how
   *  many were flagged. */
  readonly reviewEvidence: (locator: string, access: MemoryAccess) => Effect.Effect<number, MemoryError>
  /** Archive / restore — the statuses a PERSON controls. `superseded` is not settable here. */
  readonly setClaimStatus: (
    id: string,
    status: "active" | "archived" | "needs_review",
    access: MemoryAccess,
  ) => Effect.Effect<boolean, MemoryError>
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
  /** Short rows, oldest first by default — what the pruning policy and the P3 noise views scan. */
  readonly candidates: (input?: CandidateInput) => Effect.Effect<ReadonlyArray<CandidateRow>, MemoryError>
  /** Full rows for ids the caller already chose, by primary key. Missing ids are SKIPPED, not faked. */
  readonly byIds: (ids: readonly string[]) => Effect.Effect<ReadonlyArray<MemoryRow>, MemoryError>
  /** The graph slice for the visualizer: nodes + the edges among them. */
  readonly graph: (input?: GraphInput) => Effect.Effect<MemoryGraph, MemoryError>
}

// The Effect service tag — the memory tier the kb tool + auto-recall/extract hooks depend on. The
// deferred inner layer (Memory.serviceNode) provides the live client via `fromEngine`; tests provide
// a client via `stub`/`disabled` through `layerWith`.
export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MemoryClient") {}

/** The in-process engine surface the client adapts (WasmMemory satisfies this structurally). Keeps
 *  memory-client free of any engine import — the engine is injected. */
/** What `addEdge` did: `scope` is the DERIVED scope of the stored edge, absent when it was refused. */
export interface EdgeResult {
  readonly ok: boolean
  readonly scope?: string
}

export interface Engine {
  addMemory(input: MemoryInput): Promise<void>
  addEdge(input: EdgeInput & { readonly scopes?: readonly string[] }): Promise<EdgeResult>
  search(input: SearchInput): Promise<ReadonlyArray<SearchHit>>
  neighbors(id: string, opts?: { scopes?: readonly string[]; k?: number }): Promise<ReadonlyArray<Neighbor>>
  get(id: string, opts?: { scopes?: readonly string[] }): Promise<MemoryRow | null>
  path(from: string, to: string, maxHops?: number, opts?: { scopes?: readonly string[] }): Promise<PathResult | null>
  invalidate(id: string, at?: string, opts?: { scopes?: readonly string[] }): Promise<void>
  purge(id: string, opts?: { scopes?: readonly string[] }): Promise<void>
  addClaim(input: ClaimInput & { readonly scopes?: readonly string[] }): Promise<ClaimResult>
  claimHistory(id: string, opts?: { scopes?: readonly string[] }): Promise<ClaimHistory | null>
  reviewEvidence(locator: string, opts?: { scopes?: readonly string[] }): Promise<number>
  setClaimStatus(
    id: string,
    status: "active" | "archived" | "needs_review",
    opts?: { scopes?: readonly string[] },
  ): Promise<boolean>
  moveScope(from: string, to: string): Promise<void>
  clearScope(scope: string): Promise<void>
  eraseAll(): Promise<number>
  discardLegacyGlobalExtracts(): Promise<number>
  stats(): Promise<Stats>
  list(input?: ListInput): Promise<ReadonlyArray<MemoryRow>>
  candidates(input?: CandidateInput): Promise<ReadonlyArray<CandidateRow>>
  byIds(ids: readonly string[]): Promise<ReadonlyArray<MemoryRow>>
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
    addEdge: (input, access) =>
      wrap(() => engine.addEdge({ ...input, ...(access.scopes ? { scopes: access.scopes } : {}) })),
    search: (input) => wrap(() => engine.search(input)),
    // ⚠️ `access.scopes` is `undefined` ONLY for `owner`/`system`, and the engine reads that as "no
    // filter" — the same shape as before, but now it can only be reached by constructing an access
    // that says so out loud.
    neighbors: (id, access, opts) =>
      wrap(() => engine.neighbors(id, { ...(access.scopes ? { scopes: access.scopes } : {}), ...opts })),
    get: (id, access) => wrap(() => engine.get(id, access.scopes ? { scopes: access.scopes } : {})),
    path: (from, to, access, maxHops) =>
      wrap(() => engine.path(from, to, maxHops, access.scopes ? { scopes: access.scopes } : {})),
    invalidate: (id, access, at) =>
      wrap(() => engine.invalidate(id, at, access.scopes ? { scopes: access.scopes } : {})),
    purge: (id, access) => wrap(() => engine.purge(id, access.scopes ? { scopes: access.scopes } : {})),
    addClaim: (input, access) =>
      wrap(() => engine.addClaim({ ...input, ...(access.scopes ? { scopes: access.scopes } : {}) })),
    claimHistory: (id, access) => wrap(() => engine.claimHistory(id, access.scopes ? { scopes: access.scopes } : {})),
    reviewEvidence: (locator, access) =>
      wrap(() => engine.reviewEvidence(locator, access.scopes ? { scopes: access.scopes } : {})),
    setClaimStatus: (id, status, access) =>
      wrap(() => engine.setClaimStatus(id, status, access.scopes ? { scopes: access.scopes } : {})),
    moveScope: (from, to) => wrap(() => engine.moveScope(from, to)),
    clearScope: (scope) => wrap(() => engine.clearScope(scope)),
    eraseAll: () => wrap(() => engine.eraseAll()),
    discardLegacyGlobalExtracts: () => wrap(() => engine.discardLegacyGlobalExtracts()),
    stats: () => wrap(() => engine.stats()),
    list: (input) => wrap(() => engine.list(input)),
    candidates: (input) => wrap(() => engine.candidates(input)),
    byIds: (ids) => wrap(() => engine.byIds(ids)),
    graph: (input) => wrap(() => engine.graph(input)),
  }
}

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
    get: fail,
    path: fail,
    invalidate: fail,
    purge: fail,
    addClaim: fail,
    claimHistory: fail,
    reviewEvidence: fail,
    setClaimStatus: fail,
    moveScope: fail,
    clearScope: fail,
    eraseAll: fail,
    discardLegacyGlobalExtracts: fail,
    stats: fail,
    list: fail,
    candidates: fail,
    byIds: fail,
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
          status: input.status ?? "active",
          subject: input.subject ?? null,
          predicate: input.predicate ?? null,
          conflictKey: input.conflictKey ?? null,
          supersededBy: null,
          evidence: input.evidence ?? null,
          evidenceKind: input.evidenceKind ?? null,
          valid: true,
        })
      }),
    // ⚠️ Derives the edge scope EXACTLY as the engine does, and refuses the same pairs. A double that
    // is more permissive than production certifies the bug rather than catching it — which is what
    // this file's `neighbors` double did until NC-SEC-016.
    addEdge: (input, access) =>
      Effect.sync(() => {
        const from = mems.get(input.from)
        const to = mems.get(input.to)
        if (!from || !to) return { ok: false }
        const visible = (scope: string) => access.scopes === undefined || access.scopes.includes(scope)
        if (!visible(from.scope) || !visible(to.scope)) return { ok: false }
        if (!compatible(from.scope, to.scope)) return { ok: false }
        const scope = narrowest(from.scope, to.scope)
        edges.push({ from: input.from, to: input.to, type: input.type, scope })
        return { ok: true, scope }
      }),
    // ⚠️ The status filter is DUPLICATED here on purpose, defaulting exactly as the engine does. A
    // double that returned superseded claims where production hides them would let a caller pass its
    // tests while shipping the "two answers to one question" defect the lifecycle exists to end.
    search: (input) =>
      ok(
        [...mems.values()]
          .filter((m) => m.valid)
          .filter((m) => (input.statuses ?? KbClaim.RECALL_STATUSES).includes(m.status))
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
    get: (id, access) =>
      Effect.sync(() => {
        const row = mems.get(id)
        if (!row || !row.valid || (access.scopes !== undefined && !access.scopes.includes(row.scope))) return null
        return stripValid(row)
      }),
    path: (from, to, access, maxHops = 5) => {
      const visible = (memoryID: string) => {
        const row = mems.get(memoryID)
        return row !== undefined && (access.scopes === undefined || access.scopes.includes(row.scope))
      }
      if (!visible(from) || !visible(to)) return ok(null)
      const queue: string[][] = [[from]]
      const seen = new Set([from])
      while (queue.length > 0) {
        const path = queue.shift()!
        if (path.length - 1 >= maxHops) continue
        for (const edge of edges.filter((e) => e.from === path[path.length - 1] && visible(e.to))) {
          if (seen.has(edge.to)) continue
          const next = [...path, edge.to]
          if (edge.to === to) return ok({ ids: next, hops: next.length - 1 })
          seen.add(edge.to)
          queue.push(next)
        }
      }
      return ok(null)
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
    /**
     * The lifecycle, at double fidelity: the SAME identity validation, the SAME conflict key, and the
     * SAME scope refusal as the engine. Only the storage is a Map.
     *
     * ⚠️ It reuses `KbClaim` rather than re-deriving the rules. A double with its own copy of the
     * supersession rule is a second implementation, and the two drift in exactly the direction that
     * makes the double easier to satisfy — which this file has already been burned by once.
     */
    addClaim: (input, access) =>
      Effect.sync(() => {
        const scope = input.scope.trim()
        const statement = input.statement.trim()
        if (scope === "" || statement === "") return { ok: false, reason: "empty" as const, superseded: [] }
        if (access.scopes !== undefined && !access.scopes.includes(scope))
          return { ok: false, reason: "refused-scope" as const, superseded: [] }
        const identity = KbClaim.proposeIdentity({ scope, subject: input.subject, predicate: input.predicate })
        const key = identity === undefined ? undefined : KbClaim.conflictKey(identity)
        let id = KbClaim.claimID(identity, scope, statement)
        const prior = mems.get(id)
        if (prior !== undefined && !KbClaim.isRetired(prior.status))
          return { ok: true, id, status: prior.status, deduped: true, identified: key !== undefined, superseded: [] }
        if (prior !== undefined) {
          // Re-asserting something already retired mints a NEW claim rather than reviving the old row
          // — the engine does the same, and for the same reason: history is never rewritten.
          let n = 2
          while (mems.has(`${id}_r${n}`)) n++
          id = `${id}_r${n}`
        }
        const superseded =
          key === undefined
            ? []
            : [...mems.values()]
                .filter((m) => m.conflictKey === key && m.scope === scope && !KbClaim.isRetired(m.status) && m.valid)
                .map((m) => m.id)
                .filter((other) => other !== id)
        mems.set(id, {
          id,
          kind: "claim",
          text: statement,
          name: input.subject?.trim() || null,
          scope,
          source: input.source ?? null,
          confidence: input.confidence ?? null,
          relation: input.relation ?? "staged",
          status: "active",
          subject: input.subject?.trim() || null,
          predicate: input.predicate ?? null,
          conflictKey: key ?? null,
          supersededBy: null,
          evidence: null,
          evidenceKind: null,
          valid: true,
        })
        if (input.subject?.trim()) {
          const entity = KbChunk.entityID(scope, input.subject.trim())
          if (!mems.has(entity))
            mems.set(entity, {
              id: entity,
              kind: "entity",
              text: input.subject.trim(),
              name: input.subject.trim(),
              scope,
              source: input.source ?? null,
              confidence: null,
              relation: "staged",
              status: "active",
              subject: null,
              predicate: null,
              conflictKey: null,
              supersededBy: null,
              evidence: null,
              evidenceKind: null,
              valid: true,
            })
          edges.push({ from: id, to: entity, type: KbClaim.SUBJECT_EDGE, scope })
        }
        for (const item of input.evidence ?? []) {
          const locator = item.locator.trim()
          if (locator === "") continue
          const sourceNode = KbClaim.sourceID(scope, item.kind, locator)
          if (!mems.has(sourceNode))
            mems.set(sourceNode, {
              id: sourceNode,
              kind: "source",
              text: KbClaim.describeEvidence(item, new Date()),
              name: locator,
              scope,
              source: input.source ?? null,
              confidence: null,
              relation: "staged",
              status: "active",
              subject: null,
              predicate: null,
              conflictKey: null,
              supersededBy: null,
              evidence: locator,
              evidenceKind: item.kind,
              valid: true,
            })
          edges.push({ from: id, to: sourceNode, type: KbClaim.SUPPORTED_BY_EDGE, scope })
        }
        for (const old of superseded) {
          const row = mems.get(old)
          if (row) mems.set(old, { ...row, status: "superseded", supersededBy: id })
          edges.push({ from: id, to: old, type: KbClaim.SUPERSEDES_EDGE, scope })
        }
        return { ok: true, id, status: "active" as const, identified: key !== undefined, superseded }
      }),
    claimHistory: (id, access) =>
      Effect.sync(() => {
        const visible = (row: (MemoryRow & { valid: boolean }) | undefined) =>
          row !== undefined && (access.scopes === undefined || access.scopes.includes(row.scope))
        const head = mems.get(id)
        if (!visible(head)) return null
        let current = head!
        for (let hop = 0; hop < 64 && current.supersededBy !== null; hop++) {
          const next = mems.get(current.supersededBy)
          if (!visible(next)) break
          current = next!
        }
        const timeline: MemoryRow[] = [stripValid(head!)]
        const frontier = [head!.id]
        const seen = new Set(frontier)
        while (frontier.length > 0 && timeline.length < 64) {
          const from = frontier.shift()!
          for (const edge of edges.filter((e) => e.from === from && e.type === KbClaim.SUPERSEDES_EDGE)) {
            if (seen.has(edge.to)) continue
            seen.add(edge.to)
            const row = mems.get(edge.to)
            if (!visible(row)) continue
            timeline.push(stripValid(row!))
            frontier.push(edge.to)
          }
        }
        const evidence: EvidenceRow[] = []
        for (const entry of timeline)
          for (const edge of edges.filter((e) => e.from === entry.id && e.type === KbClaim.SUPPORTED_BY_EDGE)) {
            const row = mems.get(edge.to)
            if (!row) continue
            evidence.push({
              claimID: entry.id,
              id: row.id,
              kind: row.evidenceKind ?? "chat",
              locator: row.evidence ?? "",
              label: row.text,
            })
          }
        return {
          claim: stripValid(head!),
          current: current.id === head!.id ? null : stripValid(current),
          timeline,
          evidence,
        }
      }),
    reviewEvidence: (locator, access) =>
      Effect.sync(() => {
        const target = locator.trim()
        if (target === "") return 0
        const sources = [...mems.values()].filter((m) => m.kind === "source" && m.evidence === target)
        let flagged = 0
        for (const source of sources)
          for (const edge of edges.filter((e) => e.to === source.id && e.type === KbClaim.SUPPORTED_BY_EDGE)) {
            const claim = mems.get(edge.from)
            if (!claim || claim.status !== "active" || !claim.valid) continue
            if (access.scopes !== undefined && !access.scopes.includes(claim.scope)) continue
            mems.set(claim.id, { ...claim, status: "needs_review" })
            flagged++
          }
        return flagged
      }),
    setClaimStatus: (id, status, access) =>
      Effect.sync(() => {
        const row = mems.get(id)
        if (!row || row.kind !== "claim") return false
        if (access.scopes !== undefined && !access.scopes.includes(row.scope)) return false
        mems.set(id, { ...row, status })
        return true
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
    // ⚠️ The double keeps INSERTION order and calls it age. It is a test double, not a second
    // implementation of the engine's timestamps — what it must get right is the CONTRACT (short rows,
    // oldest first, no body), so a caller written against it cannot forget to hydrate.
    candidates: (input) =>
      Effect.sync(() => {
        const rows = [...mems.values()]
          .filter((m) => (input?.includeInvalid ? true : m.valid))
          .filter((m) => (input?.scopes ? input.scopes.includes(m.scope) : true))
          .filter((m) => (input?.kinds ? input.kinds.includes(m.kind) : true))
          .filter((m) => (input?.statuses ? input.statuses.includes(m.status) : true))
          .filter((m) => (input?.relation ? m.relation === input.relation : true))
          .map((m) => ({
            id: m.id,
            scope: m.scope,
            kind: m.kind,
            name: m.name,
            source: m.source,
            confidence: m.confidence,
            relation: m.relation,
            status: m.status,
            conflictKey: m.conflictKey,
          }))
        // A Map keeps insertion order, so the natural order is already oldest-first; `newest` is that
        // order reversed. Honoured rather than ignored, so a caller cannot pass against this double
        // on an ordering it never actually asked the real engine for.
        const ordered = input?.order === "newest" ? rows.toReversed() : rows
        return ordered.slice(0, input?.limit ?? 500)
      }),
    byIds: (ids) => ok(ids.map((id) => mems.get(id)).flatMap((m) => (m ? [stripValid(m)] : []))),
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
