import { Kb } from "@novaclaw/core/kb"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

// KB-A — the knowledge-base facade over the built-in PoC store. The store is
// GLOBAL (one KB per machine); `directory` on these endpoints is only routing.
// This API shape is the STABLE seam: a future `kb.url` config points the same
// contract at a heavy backend (Datalevin), and consumers cannot tell.

const root = "/kb"

const QueryParams = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  subject: Schema.optional(Schema.String),
  predicate: Schema.optional(Schema.String),
  object: Schema.optional(Schema.String),
  relation: Schema.optional(Kb.Relation),
  // Query strings carry no native booleans; accept the literal and map at the handler.
  includeRetracted: Schema.optional(Schema.Literals(["true", "false"])),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
})

const PopulatePayload = Schema.Struct({
  facts: Schema.Array(Kb.AddInput),
})

export const KbApi = HttpApi.make("kb")
  .add(
    HttpApiGroup.make("kb")
      .add(
        HttpApiEndpoint.get("stats", `${root}/stats`, {
          query: WorkspaceRoutingQuery,
          success: described(Kb.Stats, "KB stats + backend identity"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.stats",
            summary: "KB stats",
            description: "Fact counts (active/retracted, core/staged) and the serving backend's identity.",
          }),
        ),
        HttpApiEndpoint.get("query", `${root}/fact`, {
          query: QueryParams,
          success: described(Schema.Array(Kb.Fact), "Matching facts"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.query",
            summary: "Query facts",
            description:
              "Query facts by exact subject/predicate/object/relation match. Active facts only unless includeRetracted=true.",
          }),
        ),
        HttpApiEndpoint.post("add", `${root}/fact`, {
          query: WorkspaceRoutingQuery,
          payload: Kb.AddInput,
          success: described(Kb.Fact, "The stored fact (with id + provenance timestamps)"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.add",
            summary: "Add a fact",
            description:
              "Store one fact with provenance (source, agent, confidence). Defaults to the 'staged' relation — agent-written facts stay distinguishable from the curated core forever.",
          }),
        ),
        HttpApiEndpoint.post("update", `${root}/fact/:id/update`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Kb.UpdateInput,
          success: described(Kb.Fact, "The replacing fact"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.update",
            summary: "Update a fact (dated move)",
            description:
              "Never a destructive overwrite: stamps valid_to + superseded_by on the old fact and inserts the replacement — the audit chain stays intact.",
          }),
        ),
        HttpApiEndpoint.post("retract", `${root}/fact/:id/retract`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Kb.Fact, "The retracted fact (valid_to stamped)"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.retract",
            summary: "Retract a fact (dated move)",
            description: "A 'death' is a valid_to stamp, not a delete — the fact stays queryable with includeRetracted.",
          }),
        ),
        HttpApiEndpoint.post("populate", `${root}/populate`, {
          query: WorkspaceRoutingQuery,
          payload: PopulatePayload,
          success: described(Schema.Struct({ inserted: Schema.Finite }), "Bulk-load result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.populate",
            summary: "Bulk-load facts",
            description: "Load a prepared dataset (KB-B) or a batch of agent-staged facts in one call.",
          }),
        ),
        HttpApiEndpoint.get("backup", `${root}/backup`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Kb.Fact), "Every fact, including retracted (the audit trail)"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.backup",
            summary: "Export the dataset",
            description: "Full export including retracted rows — exists precisely so clear() is safe.",
          }),
        ),
        HttpApiEndpoint.post("clear", `${root}/clear`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Struct({ deleted: Schema.Finite }), "Rows deleted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kb.clear",
            summary: "Clear the KB",
            description: "The only true delete. Take a backup first.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "kb",
          description: "Knowledge-base facade (KB-A): stable CRUD/populate/backup API over a swappable fact store.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "novaclaw experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
