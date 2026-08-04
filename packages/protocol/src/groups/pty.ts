import { Pty } from "@novaclaw/schema/pty"
import { PtyTicket } from "@novaclaw/schema/pty-ticket"
import { Location } from "@novaclaw/schema/location"
import { NonNegativeInt } from "@novaclaw/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, PtyNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const PTY_CONNECT_TICKET_QUERY = "ticket"
export const PTY_CONNECT_TOKEN_HEADER = "x-novaclaw-ticket"
export const PTY_CONNECT_TOKEN_HEADER_VALUE = "1"

export const PtyShell = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  acceptable: Schema.Boolean,
})

const PTY_CONNECT_PATH = /^\/api\/pty\/[^/]+\/connect$/

export const PtyPaths = {
  shells: "/api/pty/shells",
  list: "/api/pty",
  create: "/api/pty",
  removeAll: "/api/pty",
  get: "/api/pty/:ptyID",
  update: "/api/pty/:ptyID",
  remove: "/api/pty/:ptyID",
  connectToken: "/api/pty/:ptyID/connect-token",
  connect: "/api/pty/:ptyID/connect",
} as const

// Authorization middleware skips credential checks when this matches; the PTY connect handler
// is then responsible for consuming and validating the ticket.
export function hasPtyConnectTicketURL(url: URL) {
  return PTY_CONNECT_PATH.test(url.pathname) && !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
}

export const PtyGroup = HttpApiGroup.make("server.pty")
  .add(
    HttpApiEndpoint.get("pty.shells", PtyPaths.shells, {
      success: Schema.Array(PtyShell),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.pty.shells",
        summary: "List available shells",
        description: "List shells available for human terminal sessions on this NovaClaw instance.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("pty.list", PtyPaths.list, {
      query: LocationQuery,
      success: Location.response(Schema.Array(Pty.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.list",
          summary: "List PTY sessions",
          description: "List PTY sessions for a location, including exited sessions retained until removal.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("pty.create", PtyPaths.create, {
      query: LocationQuery,
      payload: Pty.CreateInput,
      success: Location.response(Pty.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.create",
          summary: "Create PTY session",
          description: "Create a pseudo-terminal session for a location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("pty.get", PtyPaths.get, {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      success: Location.response(Pty.Info),
      error: PtyNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.get",
          summary: "Get PTY session",
          description: "Get one PTY session, including its exit code once exited.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("pty.update", PtyPaths.update, {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      payload: Pty.UpdateInput,
      success: Location.response(Pty.Info),
      error: PtyNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.update",
          summary: "Update PTY session",
          description: "Update the title or viewport size of one PTY session.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("pty.removeAll", PtyPaths.removeAll, {
      query: LocationQuery,
      success: Location.response(NonNegativeInt),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.removeAll",
          summary: "Stop all PTY sessions",
          description: "Terminate and remove every PTY session for a location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("pty.remove", PtyPaths.remove, {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: PtyNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.remove",
          summary: "Remove PTY session",
          description: "Terminate and remove one PTY session.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("pty.connectToken", PtyPaths.connectToken, {
      params: { ptyID: Pty.ID },
      query: LocationQuery,
      success: Location.response(PtyTicket.ConnectToken),
      error: [ForbiddenError, PtyNotFoundError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.pty.connectToken",
          summary: "Create PTY WebSocket token",
          description: "Create a short-lived single-use ticket for opening a PTY WebSocket connection.",
        }),
      ),
  )
  .add(
    // Query fields are decoded in the raw handler after the existence check so a missing
    // session responds with an empty 404 before any upgrade work.
    HttpApiEndpoint.get("pty.connect", PtyPaths.connect, {
      params: { ptyID: Pty.ID },
      success: Schema.Boolean,
      error: [ForbiddenError, PtyNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.pty.connect",
        summary: "Connect to PTY session",
        description: "Establish a WebSocket connection streaming PTY output and accepting terminal input.",
        transform: (operation) => ({
          ...operation,
          parameters: [
            ...(operation.parameters ?? []),
            ...["location[directory]", "location[workspace]", "cursor", PTY_CONNECT_TICKET_QUERY].map((name) => ({
              in: "query",
              name,
              schema: { type: "string" },
            })),
          ],
        }),
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "pty", description: "Experimental location-scoped PTY routes." }))
