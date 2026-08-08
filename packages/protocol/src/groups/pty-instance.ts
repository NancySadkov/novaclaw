import { Location } from "@novaclaw/schema/location"
import { Pty } from "@novaclaw/schema/pty"
import { NonNegativeInt } from "@novaclaw/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const PtyInstancePaths = {
  root: "/api/instance/pty",
} as const

export const PtyInstanceGroup = HttpApiGroup.make("server.pty-instance")
  .add(
    HttpApiEndpoint.get("pty.instanceList", PtyInstancePaths.root, {
      query: LocationQuery,
      success: Schema.Array(Location.response(Pty.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.instanceList",
          summary: "List instance PTYs",
          description: "List PTY sessions across every active location owned by one instance directory.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("pty.instanceRemoveAll", PtyInstancePaths.root, {
      query: LocationQuery,
      success: NonNegativeInt,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.instanceRemoveAll",
          summary: "Stop all instance PTYs",
          description: "Terminate every PTY session across active locations owned by one instance directory.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "pty-instance", description: "Instance-wide PTY reconciliation." }))
