import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

// The graph-memory ("kb") HTTP surface — the read/edit API the Memory viewer/editor binds to
// Memory is GLOBAL (one graph per instance, like the SQLite DB);
// `directory` on these endpoints is only routing. Read ops are open; the editing ops ride the same
// trust as the rest of the instance API and the UI gates the advanced controls to Developer level.

const root = "/memory"

// --- wire schemas (mirror core kb-graph/memory-client types; the client is the source of truth) ---

/**
 * ⚠️ **An undeclared field is silently STRIPPED on the way out**, which is how the whole claim
 * lifecycle stayed invisible to the Memory app after P1 shipped it: the store returned `status`,
 * `subject`, `predicate`, `supersededBy` and the evidence columns on every row, and this struct
 * dropped all six without a word. The app could not distinguish a current answer from one that had
 * been corrected, so its own "Incl. forgotten" toggle was inert — a control that could not have
 * worked, under a schema that answered 200.
 */
const MemoryRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  name: Schema.NullOr(Schema.String),
  scope: Schema.String,
  source: Schema.NullOr(Schema.String),
  confidence: Schema.NullOr(Schema.Finite),
  relation: Schema.String,
  status: Schema.String,
  subject: Schema.NullOr(Schema.String),
  predicate: Schema.NullOr(Schema.String),
  conflictKey: Schema.NullOr(Schema.String),
  supersededBy: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(Schema.String),
  evidenceKind: Schema.NullOr(Schema.String),
})
const SearchHit = Schema.Struct({ ...MemoryRow.fields, score: Schema.Finite })
const Neighbor = Schema.Struct({ id: Schema.String, type: Schema.String, text: Schema.String })
const EdgeRow = Schema.Struct({ from: Schema.String, to: Schema.String, type: Schema.String })
const Stats = Schema.Struct({ total: Schema.Finite, valid: Schema.Finite })
/** ⚠️ DECLARED, because an undeclared field is silently stripped on the way out — the whole point of
 *  this struct is that the client can tell a slice from the complete graph. */
const GraphSlice = Schema.Struct({
  partial: Schema.Boolean,
  total: Schema.Finite,
  returned: Schema.Finite,
  omitted: Schema.Finite,
  reason: Schema.Literals(["complete", "connected-first", "scan-capped"]),
})
const MemoryGraph = Schema.Struct({
  nodes: Schema.Array(MemoryRow),
  edges: Schema.Array(EdgeRow),
  slice: GraphSlice,
})
const PathResult = Schema.NullOr(Schema.Struct({ ids: Schema.Array(Schema.String), hops: Schema.Finite }))

const CsvOptional = Schema.optional(Schema.String) // comma-separated scopes/kinds in the query string

const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scopes: CsvOptional,
  kinds: CsvOptional,
  /** The lifecycle lens: a comma-separated status set. Unset = every status, history included. */
  statuses: CsvOptional,
  includeInvalid: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  offset: Schema.optional(Schema.NumberFromString),
})
const GraphQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scopes: CsvOptional,
  limit: Schema.optional(Schema.NumberFromString),
})

const SearchPayload = Schema.Struct({
  query: Schema.String,
  k: Schema.optional(Schema.Finite),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  kinds: Schema.optional(Schema.Array(Schema.String)),
})
const NeighborsPayload = Schema.Struct({ id: Schema.String, k: Schema.optional(Schema.Finite) })
const PathPayload = Schema.Struct({ from: Schema.String, to: Schema.String, maxHops: Schema.optional(Schema.Finite) })
const RememberPayload = Schema.Struct({
  text: Schema.String,
  name: Schema.optional(Schema.String),
  scope: Schema.String,
  kind: Schema.optional(Schema.String),
})
const IdPayload = Schema.Struct({ id: Schema.String })
const ScopePayload = Schema.Struct({ scope: Schema.String })
const IngestPayload = Schema.Struct({
  text: Schema.String,
  name: Schema.String,
  scope: Schema.optional(Schema.String),
  /**
   * CAP on how many passages to absorb — read with a model so each becomes named entities the graph
   * can connect. **Absent absorbs the whole document**; `0` stores passages without reading them.
   *
   * ⚠️ A count rather than a boolean so a caller can bound the spend deliberately. The default is
   * "all" because a document stored and never read is a document with its pages attached, not
   * knowledge — the graph looks populated while holding nothing you could ask a question about.
   */
  absorb: Schema.optional(Schema.Finite),
})
const IngestResult = Schema.Struct({
  stored: Schema.Finite,
  passages: Schema.Finite,
  /** Passages queued for absorption. The work runs DETACHED, so this is not a completion count. */
  absorbing: Schema.optional(Schema.Finite),
})

const meta = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({ identifier, summary, description })

export const MemoryApi = HttpApi.make("memory").add(
  HttpApiGroup.make("memory")
    .add(
      HttpApiEndpoint.get("stats", `${root}/stats`, {
        query: WorkspaceRoutingQuery,
        success: described(Stats, "Total + currently-valid memory counts"),
      }).annotateMerge(meta("memory.stats", "Memory counts", "Total and currently-valid memory counts.")),
    )
    .add(
      HttpApiEndpoint.get("list", `${root}/list`, {
        query: ListQuery,
        success: described(Schema.Array(MemoryRow), "Memories, newest first (valid only unless includeInvalid)"),
      }).annotateMerge(
        meta(
          "memory.list",
          "List memories",
          "Enumerate memories (no query); filter by scope/kind/validity, paginated.",
        ),
      ),
    )
    .add(
      HttpApiEndpoint.get("graph", `${root}/graph`, {
        query: GraphQuery,
        success: described(MemoryGraph, "Graph slice: nodes + the edges among them"),
      }).annotateMerge(
        meta(
          "memory.graph",
          "Memory graph",
          "A bounded graph slice for the visualizer: nodes + valid edges among them.",
        ),
      ),
    )
    .add(
      HttpApiEndpoint.post("search", `${root}/search`, {
        query: WorkspaceRoutingQuery,
        payload: SearchPayload,
        success: described(Schema.Array(SearchHit), "Ranked memory hits"),
      }).annotateMerge(meta("memory.search", "Search memory", "Keyword/FTS search over memory, scope-filtered.")),
    )
    .add(
      HttpApiEndpoint.post("neighbors", `${root}/neighbors`, {
        query: WorkspaceRoutingQuery,
        payload: NeighborsPayload,
        success: described(Schema.Array(Neighbor), "One-hop typed neighbours"),
      }).annotateMerge(meta("memory.neighbors", "Memory neighbours", "The directly-linked memories of one node.")),
    )
    .add(
      HttpApiEndpoint.post("path", `${root}/path`, {
        query: WorkspaceRoutingQuery,
        payload: PathPayload,
        success: described(PathResult, "Shortest path between two memories, if any"),
      }).annotateMerge(meta("memory.path", "Memory path", "Shortest path (by edge count) between two memories.")),
    )
    .add(
      HttpApiEndpoint.post("remember", `${root}/remember`, {
        query: WorkspaceRoutingQuery,
        payload: RememberPayload,
        success: described(Schema.Struct({ id: Schema.String }), "The new memory's id"),
        error: InvalidRequestError,
      }).annotateMerge(meta("memory.remember", "Add a memory", "Record a new memory (staged) in the given scope.")),
    )
    .add(
      HttpApiEndpoint.post("invalidate", `${root}/invalidate`, {
        query: WorkspaceRoutingQuery,
        payload: IdPayload,
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(
        meta(
          "memory.invalidate",
          "Forget (invalidate)",
          "Supersede a memory bitemporally — kept in history, dropped from search.",
        ),
      ),
    )
    .add(
      HttpApiEndpoint.post("purge", `${root}/purge`, {
        query: WorkspaceRoutingQuery,
        payload: IdPayload,
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(
        meta("memory.purge", "Purge (hard delete)", "Hard-delete a memory with no history — for secrets."),
      ),
    )
    .add(
      HttpApiEndpoint.post("ingest", `${root}/ingest`, {
        query: WorkspaceRoutingQuery,
        payload: IngestPayload,
        success: described(IngestResult, "How many passages were stored, and how many the document chunked into"),
        error: InvalidRequestError,
      }).annotateMerge(
        meta(
          "memory.ingest",
          "Ingest a document",
          "Chunk a text document into searchable passages. Idempotent: re-ingesting the same document stores nothing new. Pass `absorb: <n>` to also READ the first n passages with a model, turning them into named entities — each one costs a model call.",
        ),
      ),
    )
    .add(
      HttpApiEndpoint.post("clearScope", `${root}/clearScope`, {
        query: WorkspaceRoutingQuery,
        payload: ScopePayload,
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(
        meta("memory.clearScope", "Clear a scope", "Delete every memory in a scope (e.g. one chat, or all global)."),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "memory", description: "The graph-memory viewer/editor API (kb-graph)." }),
    ),
)
