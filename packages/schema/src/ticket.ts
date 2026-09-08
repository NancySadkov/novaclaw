export * as Ticket from "./ticket"

import { Schema } from "effect"
import { PositiveInt } from "./schema"

/**
 * A short-lived, single-use ticket for ONE route that a browser reaches without a header.
 *
 * 🔴 **Two callers, one shape, one name.** This was `PtyTicket.ConnectToken` while a WebSocket
 * upgrade was the only request on this surface that structurally cannot set `Authorization`. A
 * `<a download>` is the second: the browser fetches the URL itself, so a credential never reaches
 * it either. The wire type was renamed rather than copied — a `POST /api/fs/read-token` whose
 * response schema is called `PtyTicket…` is a public contract that lies about itself, and this
 * surface has to be good enough for a stranger to build against.
 *
 * ⚠️ **A ticket is not a credential.** It authorizes one scope for one use inside a minute, so
 * unlike `auth_token` it is admissible in a URL. `expires_in` is seconds, matching OAuth's spelling
 * because every client library already knows what it means.
 */
export const AccessToken = Schema.Struct({
  ticket: Schema.String,
  expires_in: PositiveInt,
}).annotate({ identifier: "Ticket.AccessToken" })
export interface AccessToken extends Schema.Schema.Type<typeof AccessToken> {}

/**
 * The query parameter carrying the ticket, on the route the ticket is FOR.
 *
 * ⚠️ **One constant, because four files must agree on it**: the endpoint declaration, the
 * authorization middleware's admission test, the handler that consumes it, and the browser client
 * that writes it. A route whose middleware admits `?ticket=` while its handler reads `?t=` accepts
 * every ticket and spends none — an open door that no test of the happy path can see. It lives in
 * `@novaclaw/schema` rather than `@novaclaw/protocol` because the app is one of those four and does
 * not depend on the protocol package.
 */
export const TICKET_QUERY = "ticket"

/**
 * The header a MINT request must carry, and why minting needs one at all.
 *
 * A custom header cannot be set by a cross-origin form or `<img>`, so requiring it forces a CORS
 * preflight — which means a hostile page cannot mint a ticket in the user's browser without first
 * passing the server's origin policy. The mint route is authenticated like every other route; this
 * closes the CSRF shape where the browser's own credential is used against it.
 */
export const TICKET_REQUEST_HEADER = "x-novaclaw-ticket"

export const TICKET_REQUEST_HEADER_VALUE = "1"
