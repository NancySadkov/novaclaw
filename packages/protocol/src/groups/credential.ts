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
    /**
     * 🔴 NC-REL-030(b) — "are any stored secrets unreadable, and what repairs them?"
     *
     * ⚠️ No location query. A lost `credential.key` is an INSTANCE-wide fault: the file sits beside
     * the database, and every location's secrets are sealed with the same one. Scoping this to a
     * location would let the answer depend on which project happened to be open.
     *
     * ⚠️ `notice` is server-composed prose rather than a count the client formats. The message has
     * to name the key file and the data directory — neither of which the client knows, and the
     * directory is exactly what makes the message actionable.
     */
    HttpApiEndpoint.get("credential.repair.status", "/api/credential/repair", {
      success: Schema.Struct({
        unreadable: Schema.Array(Schema.Struct({ path: Schema.String })),
        notice: Schema.optional(Schema.String),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.credential.repair.status",
        summary: "Check stored-secret readability",
        description: "Report stored secrets that cannot be decrypted, with a message naming the key file to restore.",
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
