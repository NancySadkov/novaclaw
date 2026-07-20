import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

// The graph-memory ("kb") HTTP surface — the read/edit API the Memory viewer/editor binds to
// (notes/kb-graph-plan.md §5). Memory is GLOBAL (one graph per instance, like the SQLite DB);
// `directory` on these endpoints is only routing. Read ops are open; the editing ops ride the same
// trust as the rest of the instance API and the UI gates the advanced controls to Developer level.

const root = "/memory"

// --- wire schemas (mirror core kb-graph/memory-client types; the client is the source of truth) ---

const MemoryRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  name: Schema.NullOr(Schema.String),
  scope: Schema.String,
  source: Schema.NullOr(Schema.String),
  confidence: Schema.NullOr(Schema.Number),
  relation: Schema.String,
})
const SearchHit = Schema.Struct({ ...MemoryRow.fields, score: Schema.Number })
const Neighbor = Schema.Struct({ id: Schema.String, type: Schema.String, text: Schema.String })
const EdgeRow = Schema.Struct({ from: Schema.String, to: Schema.String, type: Schema.String })
const Stats = Schema.Struct({ total: Schema.Number, valid: Schema.Number })
const MemoryGraph = Schema.Struct({ nodes: Schema.Array(MemoryRow), edges: Schema.Array(EdgeRow) })
const PathResult = Schema.NullOr(Schema.Struct({ ids: Schema.Array(Schema.String), hops: Schema.Number }))

const CsvOptional = Schema.optional(Schema.String) // comma-separated scopes/kinds in the query string

const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scopes: CsvOptional,
  kinds: CsvOptional,
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
  k: Schema.optional(Schema.Number),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  kinds: Schema.optional(Schema.Array(Schema.String)),
})
const NeighborsPayload = Schema.Struct({ id: Schema.String, k: Schema.optional(Schema.Number) })
const PathPayload = Schema.Struct({ from: Schema.String, to: Schema.String, maxHops: Schema.optional(Schema.Number) })
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
})
const IngestResult = Schema.Struct({ stored: Schema.Number, passages: Schema.Number })

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
      }).annotateMerge(meta("memory.list", "List memories", "Enumerate memories (no query); filter by scope/kind/validity, paginated.")),
    )
    .add(
      HttpApiEndpoint.get("graph", `${root}/graph`, {
        query: GraphQuery,
        success: described(MemoryGraph, "Graph slice: nodes + the edges among them"),
      }).annotateMerge(meta("memory.graph", "Memory graph", "A bounded graph slice for the visualizer: nodes + valid edges among them.")),
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
      }).annotateMerge(meta("memory.invalidate", "Forget (invalidate)", "Supersede a memory bitemporally — kept in history, dropped from search.")),
    )
    .add(
      HttpApiEndpoint.post("purge", `${root}/purge`, {
        query: WorkspaceRoutingQuery,
        payload: IdPayload,
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(meta("memory.purge", "Purge (hard delete)", "Hard-delete a memory with no history — for secrets.")),
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
          "Chunk a text document into searchable passages. Idempotent: re-ingesting the same document stores nothing new.",
        ),
      ),
    )
    .add(
      HttpApiEndpoint.post("clearScope", `${root}/clearScope`, {
        query: WorkspaceRoutingQuery,
        payload: ScopePayload,
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(meta("memory.clearScope", "Clear a scope", "Delete every memory in a scope (e.g. one chat, or all global).")),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "memory", description: "The graph-memory viewer/editor API (kb-graph)." }),
    ),
)
