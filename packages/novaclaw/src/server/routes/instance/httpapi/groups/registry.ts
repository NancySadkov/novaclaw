import { DbRegistry } from "@novaclaw/core/db-registry"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

// The Registry app's HTTP surface (owner directive 2026-07-15): Regedit-style browse/edit of
// the instance SQLite database. The database is GLOBAL (one per instance); `directory` on
// these endpoints is only routing. The UI gates the app tile to the Developer expertise
// level; the endpoints themselves are as trusted as the rest of the instance API.

const root = "/registry"

const RowsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  table: Schema.String,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
  offset: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

const UpdateRowPayload = Schema.Struct({
  table: Schema.String,
  rowid: Schema.Number,
  values: Schema.Record(Schema.String, Schema.Unknown),
})

const DeleteRowPayload = Schema.Struct({
  table: Schema.String,
  rowid: Schema.Number,
})

export const RegistryApi = HttpApi.make("registry").add(
  HttpApiGroup.make("registry")
    .add(
      HttpApiEndpoint.get("tables", `${root}/tables`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(DbRegistry.TableSummary), "Every user table with its row count"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "registry.tables",
          summary: "List database tables",
          description: "Every user table in the instance database with its current row count.",
        }),
      ),
      HttpApiEndpoint.get("rows", `${root}/rows`, {
        query: RowsQuery,
        success: described(DbRegistry.TablePage, "One page of rows (rowid-addressed)"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "registry.rows",
          summary: "Page table rows",
          description: "One page of a table's rows, rowid-addressed, values in their raw stored form.",
        }),
      ),
      HttpApiEndpoint.post("updateRow", `${root}/row/update`, {
        query: WorkspaceRoutingQuery,
        payload: UpdateRowPayload,
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "registry.updateRow",
          summary: "Update one row",
          description: "Update the given columns of one row (by rowid). Unknown columns are rejected.",
        }),
      ),
      HttpApiEndpoint.post("insertRow", `${root}/row/insert`, {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ table: Schema.String, values: Schema.Record(Schema.String, Schema.Unknown) }),
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "registry.insertRow",
          summary: "Insert a row",
          description: "Insert a new row into a table. Constraint violations come back as a readable error.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("deleteRow", `${root}/row/delete`, {
        query: WorkspaceRoutingQuery,
        payload: DeleteRowPayload,
        success: described(Schema.Boolean, "True on success"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "registry.deleteRow",
          summary: "Delete one row",
          description: "Delete one row by rowid. Foreign-key cascades apply — this is real database editing.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "registry",
        description: "Developer-mode database registry (Regedit-style browse/edit).",
      }),
    ),
)
