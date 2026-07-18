import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// 4E — the review surface for SESSION-defined ad-hoc recipes: list what a session's model
// invented, discard the junk, or PROMOTE the keepers into the instance-wide `adhoc_tools`
// settings store so they become permanent (config-sqlite: the store is the config).

const root = "/adhoc"

const Recipe = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  manual: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
})

export const AdhocApi = HttpApi.make("adhoc")
  .add(
    HttpApiGroup.make("adhoc")
      .add(
        HttpApiEndpoint.get("list", `${root}/session/:sessionID`, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Recipe), "The session's model-defined recipes"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "adhoc.list",
            summary: "List session recipes (4E)",
            description: "The ad-hoc tool recipes the model defined in this session.",
          }),
        ),
        HttpApiEndpoint.delete("discard", `${root}/session/:sessionID/:name`, {
          params: { sessionID: Schema.String, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Struct({ removed: Schema.Boolean }), "Whether a recipe was removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "adhoc.discard",
            summary: "Discard a session recipe (4E)",
            description: "Throw away one session-defined recipe by name.",
          }),
        ),
        HttpApiEndpoint.post("promote", `${root}/session/:sessionID/:name/promote`, {
          params: { sessionID: Schema.String, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Struct({ promoted: Schema.String }), "The config key written"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "adhoc.promote",
            summary: "Promote a session recipe to instance config (4E)",
            description:
              "Write a session-defined recipe into the instance adhoc_tools settings store, making it permanent.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "adhoc",
          description: "4E: review/discard/promote session-defined ad-hoc tool recipes.",
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
