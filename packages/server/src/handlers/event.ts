import { EventV2 } from "@novaclaw/core/event"
import { NovaClawEvent } from "@novaclaw/protocol/groups/event"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { Log } from "@novaclaw/schema/log"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi, handlerLayer } from "../handler-api"

const subscriberCapacity = 256

/**
 * The types this route's DECLARED wire union (`V2Event`) can carry.
 *
 * 🔴 The bus is WIDER than the wire, and that asymmetry used to kill the subscription.
 * `EventV2.allBounded` hands us every event the instance publishes — the full
 * `EventManifest.Definitions` — while `NovaClawEvent` is `ServerDefinitions` ∪ `server.connected`,
 * roughly twenty types narrower (`session.status`, `session.error`,
 * `permission.*`, `question.*`, `mcp.*`, `installation.*`, `workspace.*`, `worktree.*`,
 * `vcs.branch.updated`). `Schema.encodeUnknownSync` THROWS on a non-member, and a throw inside
 * `Stream.map` is a defect that terminates the response body.
 *
 * Measured 2026-08-25 against a plain `serve` on this branch: a subscriber saw `server.connected`,
 * then `session.created`, and the stream CLOSED 0.1 s after a prompt was admitted — the first
 * `session.status` of the run killed it. Nothing was logged, and the client cannot tell a dead
 * stream from an idle one, so it reads as "the instance publishes no session events at all". That
 * is the shape reported in the P2 blocker.
 *
 * Filtering here is not a workaround, it is the contract: OpenAPI publishes `V2Event` as this
 * stream's element type, so an internal-only event was never something a conforming client could
 * parse. What it must not do is take the connection down with it.
 */
const wireTypes = new Set<string>(["server.connected", ...EventManifest.ServerDefinitions.map((one) => one.type)])

const encode = Schema.encodeUnknownSync(NovaClawEvent)

/**
 * Encode one event, or drop it.
 *
 * The membership test above already excludes every KNOWN non-member, so reaching the `catch` means
 * a member whose PAYLOAD would not encode. Dropping one event is a hole in one client's history;
 * dying takes every later event for every open subscriber with it, silently. A public stream that
 * can be terminated by one malformed payload is not a surface a stranger can build on.
 */
function eventData(event: { readonly type: string }): Sse.Event | undefined {
  if (!wireTypes.has(event.type)) return undefined
  try {
    return { _tag: "Event", event: "message", id: undefined, data: JSON.stringify(encode(event)) }
  } catch {
    return undefined
  }
}

/**
 * The element stream this route serves, before SSE framing and the heartbeat.
 *
 * Exported so a regression test can drive the EXACT pipeline the handler installs rather than a
 * re-typed copy of it. The subscription is acquired inside, because installing the listener before
 * readiness is observable is the property that keeps the `server.connected` boundary lossless.
 */
export const publicEventStream = (events: EventV2.Interface, capacity = subscriberCapacity) =>
  Effect.gen(function* () {
    const connected = { id: EventV2.ID.create(), type: "server.connected", data: {} }
    // One line per DISTINCT dropped type per subscription. `session.status` fires many times a
    // turn, so logging each drop would bury the signal it exists to carry.
    const reported = new Set<string>()
    // Acquiring the bounded stream installs its listener before readiness is observable.
    const live = yield* EventV2.allBounded(events, capacity)
    return Stream.make(connected).pipe(
      Stream.concat(live),
      Stream.map((event) => ({ event, encoded: eventData(event) })),
      Stream.tap(({ event, encoded }) =>
        encoded !== undefined || reported.has(event.type)
          ? Effect.void
          : Effect.sync(() => reported.add(event.type)).pipe(
              Effect.andThen(Log.event("server.event.dropped", { "instance.event.type": event.type })),
            ),
      ),
      // ⚠️ Narrow ONLY the field being tested. Spelling the element out as
      // `{ event: { readonly type: string }; encoded: Sse.Event }` widens `event` to a supertype of
      // what the stream carries, so the predicate's type is not assignable to its parameter's and
      // tsgo refuses it (TS2677) — while `bunx tsgo -b <pkg>` reports clean from stale project refs.
      Stream.filter((one): one is typeof one & { encoded: Sse.Event } => one.encoded !== undefined),
      Stream.map((one) => one.encoded),
    )
  })

export const EventHandler = handlerLayer(
  HttpApiBuilder.group(EventApi, "server.event", (handlers) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      return handlers.handleRaw("event.subscribe", () =>
        Effect.gen(function* () {
          const output = Stream.unwrap(publicEventStream(events)).pipe(Stream.pipeThroughChannel(Sse.encode()))
          const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
          return HttpServerResponse.stream(
            output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
            {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }),
      )
    }),
  ),
)
