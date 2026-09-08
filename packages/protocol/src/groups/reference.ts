import { Location } from "@novaclaw/schema/location"
import { Reference } from "@novaclaw/schema/reference"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ReferenceGroup = HttpApiGroup.make("server.reference")
  .add(
    HttpApiEndpoint.get("reference.list", "/api/reference", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Reference.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.reference.list",
          summary: "List references",
          description: "List references available in the requested location.",
        }),
      ),
  )
  .add(
    // Self-healing (AGENTS.md): same gap as `agent.remove`. A reference alias points at a repo or
    // directory; when that target moves, `PATCH /config` can re-point it but never drop it, so a
    // stale alias was permanent. Instance-wide (the store is global), like the list it complements.
    HttpApiEndpoint.delete("reference.remove", "/api/reference/:name", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.reference.remove",
          summary: "Remove reference",
          description:
            "Delete a config-defined reference alias from the instance reference store. Takes effect fully on the next serve boot.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "reference",
      description: "Location-scoped project references.",
    }),
  )
