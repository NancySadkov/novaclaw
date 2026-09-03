import { Location } from "@novaclaw/schema/location"
import { Vcs } from "@novaclaw/schema/vcs"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

/**
 * THE VCS ROUTES, moved here from the legacy instance API.
 *
 * 🔴 These were the last five legacy paths of the event-stream shrink (`/vcs`, `/vcs/status`,
 * `/vcs/diff`, `/vcs/diff/raw`, `/vcs/apply`), and the reason they outlived every sibling family was
 * recorded as "blocked: `Vcs.Service` is novaclaw-internal". That was measured and found FALSE on
 * 2026-09-03. Declaring a route and serving it are separate jobs: `packages/protocol` needs only the
 * shapes, which moved to `@novaclaw/schema/vcs`, while the handler stays in `packages/novaclaw`
 * beside the service that needs that package's `Git`, `InstanceState` and `EventV2Bridge`. Nothing
 * had to move to core, and the "capability we would lose" was never at risk.
 *
 * ⚠️ `vcs.diffRaw` is the one endpoint with no `Location` envelope, deliberately: it serves a patch
 * as `text/x-diff` so `git apply` can eat the response body directly, and wrapping it in JSON would
 * take that away. `fs.read` makes the same trade for the same reason.
 */

/** Exported so `httpapi-query-schema-drift` can hold the served spec against the declaration. */
export const VcsDiffQuery = Schema.Struct({
  ...LocationQuery.fields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export const VcsGroup = HttpApiGroup.make("server.vcs")
  .add(
    HttpApiEndpoint.get("vcs.get", "/api/vcs", {
      query: LocationQuery,
      success: Location.response(Vcs.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.vcs.get",
          summary: "Get VCS info",
          description: "Retrieve version control information for a location, such as its branch and default branch.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("vcs.status", "/api/vcs/status", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Vcs.FileStatus)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.vcs.status",
          summary: "Get VCS status",
          description: "Retrieve the changed files in the working tree, with counts and no patches.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("vcs.diff", "/api/vcs/diff", {
      query: VcsDiffQuery,
      success: Location.response(Schema.Array(Vcs.FileDiff)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.vcs.diff",
          summary: "Get VCS diff",
          description: "Retrieve the diff for the working tree (mode=git) or against the default branch (mode=branch).",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("vcs.diffRaw", "/api/vcs/diff/raw", {
      query: LocationQuery,
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.vcs.diffRaw",
          summary: "Get raw VCS diff",
          description: "Retrieve a raw patch of the uncommitted changes, as text a patch tool can apply directly.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("vcs.apply", "/api/vcs/apply", {
      query: LocationQuery,
      payload: Vcs.ApplyInput,
      success: Location.response(Vcs.ApplyResult),
      // The legacy route carried a bespoke `VcsApplyError` at 400 whose only extra field was the
      // reason. `InvalidRequestError` is the contract's 400 and carries `kind`, so the reason
      // survives without a second error vocabulary — ruling 11 applies to errors too.
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.vcs.apply",
          summary: "Apply VCS patch",
          description:
            "Apply a raw patch to the working tree. Fails with kind 'non-git' outside a repository and 'not-clean' when the tree has changes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "vcs",
      description: "Version control routes for a location.",
    }),
  )
