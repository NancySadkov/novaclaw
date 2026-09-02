import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

// Home-app manifests — the launcher tiles an AGENT or a plugin contributed (`register-app`), as
// opposed to the built-ins, which are code. INSTANCE-GLOBAL, like recipes: a tile belongs to the
// install, not to a location.
//
// 🔴 Only REMOVE lives here. Listing and registering are still the legacy `GET /app` and `POST /app`
// (`novaclaw/src/server/routes/instance/httpapi`), and moving them is a migration of its own. This
// endpoint is on the /api/* contract because that is the rule for anything new — ruling 11 pins the
// legacy surface shrink-only, and `sdk-js`'s legacy-path ledger fails a build that grows it. The
// first draft of this endpoint was written as `DELETE /app/:id` on the legacy group and the ledger
// caught it in the same run, which is the ledger doing exactly its job.
//
// Why it exists at all: registering a tile was reachable and removing one was not, so an agent could
// add to a person's home screen and nothing in the product could take it back off.

export const AppGroup = HttpApiGroup.make("server.app")
  .add(
    HttpApiEndpoint.delete("app.remove", "/api/app/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.app.remove",
        summary: "Remove a home app",
        description:
          "Delete a contributed home-app manifest by id. Built-in tiles are not manifests and are unaffected; " +
          "deleting an id that does not exist succeeds, so the call is idempotent.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "home apps",
      description: "Launcher tiles an agent or a plugin contributed. Instance-global; built-in tiles are code.",
    }),
  )
