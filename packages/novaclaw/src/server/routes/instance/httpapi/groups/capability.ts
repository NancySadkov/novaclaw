import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const Unavailable = Schema.Struct({
  capability: Schema.String,
  kind: Schema.Literals(["failed", "timeout", "disabled", "unsupported"]),
  summary: Schema.String,
  detail: Schema.optional(Schema.String),
  repair: Schema.optional(Schema.Array(Schema.String)),
})

const Status = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({ state: Schema.Literal("starting"), since: Schema.Finite }),
  Schema.Struct({ state: Schema.Literal("ready"), since: Schema.Finite }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Unavailable,
    at: Schema.Finite,
    attempts: Schema.Finite,
  }),
])

export const CapabilitySnapshot = Schema.Struct({ name: Schema.String, status: Status })

const RetryParams = Schema.Struct({ name: Schema.String })

export const CapabilityApi = HttpApi.make("capability").add(
  HttpApiGroup.make("capability")
    .add(
      HttpApiEndpoint.get("list", "/api/capability", {
        query: WorkspaceRoutingQuery,
        success: described(
          Schema.Array(CapabilitySnapshot),
          "Every declared optional capability and its live state, without starting idle capabilities",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.list",
          summary: "List optional capabilities",
          description: "Inspect the live capability graph without waking capabilities that have not been used.",
        }),
      ),
      HttpApiEndpoint.post("retry", "/api/capability/:name/retry", {
        params: RetryParams,
        query: WorkspaceRoutingQuery,
        success: described(CapabilitySnapshot, "The capability's state after the retry attempt"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.retry",
          summary: "Retry an unavailable capability",
          description:
            "Re-arm one cached startup failure and attempt it once. Ready, starting, and idle capabilities are unchanged.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "capability",
        description: "Live optional-capability status and recovery controls for the Developer-mode Debug app.",
      }),
    )
    .middleware(Authorization),
)
