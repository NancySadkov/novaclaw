import { Credential } from "@novaclaw/schema/credential"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const CredentialGroup = HttpApiGroup.make("server.credential")
  .add(
    HttpApiEndpoint.patch("credential.update", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      query: LocationQuery,
      payload: Schema.Struct({ label: Schema.String }),
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.credential.update",
          summary: "Update credential",
          description: "Update a stored credential label.",
        }),
      ),
  )
  .add(
    // Credential stores are instance-wide, independent of the selected project.
    HttpApiEndpoint.get("credential.repair.status", "/api/credential/repair", {
      success: Schema.Struct({
        unreadable: Schema.Array(Schema.Struct({ path: Schema.String })),
        notice: Schema.optional(Schema.String),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.credential.repair.status",
        summary: "Check stored-secret readability",
        description: "Report malformed stored secrets and supported account or identity repair actions.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("credential.remove", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.credential.remove",
          summary: "Remove credential",
          description: "Remove a stored integration credential.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "credentials",
      description:
        "Secrets an integration was given: relabel one, remove one, and check whether any have become unreadable.",
    }),
  )
