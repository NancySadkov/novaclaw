export * as Ticket from "./ticket"

import { Ticket } from "@novaclaw/schema/ticket"
import { Cache, Context, Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"

/**
 * SHORT-LIVED, SINGLE-USE AUTHORIZATION for the requests a browser issues on its own.
 *
 * 🔴 **Two callers, one mechanism.** `Authorization` is a header, and there are exactly two requests
 * on this surface that cannot carry one: a WebSocket upgrade (`pty.connect`) and a `<a download>`
 * (`fs.read`), where the BROWSER does the fetching. This was `PtyTicket` while there was one of
 * them. The second did not get a copy: a ticket store is a TTL cache plus an atomic take, and two of
 * those means two expiry policies, two capacities and two chances for a scope comparison to drift.
 *
 * 🔴 **The scope is compared as ONE canonical string, never field by field.** The version this
 * generalises had a hand-written `matches(record, input)` comparing three properties by name — so a
 * fourth field added to a scope would have been minted into the ticket and ignored when it was
 * spent, which is a widened capability that no test looking at the new field would notice. Here
 * every own property of the scope object participates by construction, because the comparison never
 * enumerates them.
 *
 * ⚠️ **A ticket is not a credential and must not become one.** It names one target, it works once,
 * and it dies in a minute — which is why it is admissible in a URL where `auth_token` (the
 * instance's password, base64) is refused outright: `workspaceProxyURL` copies a query string
 * wholesale into a proxy target, and a capability that has already been spent is worth nothing to
 * the far end.
 */

const DEFAULT_TTL = Duration.seconds(60)
const CAPACITY = 10_000

export const AccessToken = Ticket.AccessToken

/**
 * What a ticket authorizes. Every arm carries the LOCATION as well as the target, because the same
 * name means a different file in a different directory and a ticket must not cross that line.
 *
 * ⚠️ Plain `string`s rather than the branded `PtyID` / `WorkspaceV2.ID`: the store compares them and
 * nothing else, and importing the brands would tie a generic mechanism back to one of its callers.
 * A branded string is assignable here, so no caller loses a type.
 */
export type Scope =
  | {
      readonly kind: "pty.connect"
      readonly ptyID: string
      readonly directory?: string
      readonly workspaceID?: string
    }
  | {
      readonly kind: "fs.read"
      /** The file, relative to the location — the wildcard segment of `/api/fs/read/*`. */
      readonly path: string
      readonly directory?: string
      readonly workspaceID?: string
    }

/**
 * The scope as one comparable string.
 *
 * ⚠️ `undefined` is DROPPED rather than serialised, so an absent property and an explicitly
 * undefined one are the same scope. They reach this function both ways — the PTY handler spreads a
 * record that always carries both location keys, a test builds the literal without them — and a
 * store that told those two apart would refuse a ticket it had just minted.
 */
const canonical = (scope: Scope): string =>
  JSON.stringify(
    Object.entries(scope)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  )

export interface Interface {
  issue(scope: Scope): Effect.Effect<typeof AccessToken.Type>
  /** `true` exactly once per issued ticket, and only for the scope it was issued for. */
  consume(scope: Scope, ticket: string): Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Ticket") {}

// Tickets are inserted via Cache.set and removed atomically via invalidateWhen. The lookup is
// never invoked; it dies if it ever is, which would signal a misuse of the Service interface.
const noLookup = () => Effect.die("Ticket cache must be used via set/invalidateWhen, never get")

// Visible for tests so the TTL can be shortened. Production uses `layer` with the default TTL.
export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    const cache = yield* Cache.make<string, string>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    const expiresIn = Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))
    return Service.of({
      issue: Effect.fn("Ticket.issue")(function* (scope) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(cache, ticket, canonical(scope))
        return { ticket, expires_in: expiresIn }
      }),
      consume: Effect.fn("Ticket.consume")(function* (scope, ticket) {
        const wanted = canonical(scope)
        return yield* Cache.invalidateWhen(cache, ticket, (stored) => stored === wanted)
      }),
    })
  })

export const layer = Layer.effect(Service, make())

export const defaultLayer = layer
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })
