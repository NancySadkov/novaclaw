import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@novaclaw/core/event"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"
import { Log } from "@novaclaw/schema/log"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

/**
 * A SUBSCRIPTION OUTLIVES AN INSTANCE REBUILD.
 *
 * 🔴 This used to end on `server.instance.disposed`:
 *
 * ```ts
 * Stream.takeUntil((event) => event.type === "server.instance.disposed")
 * ```
 *
 * and that single line was the `attach mode` flake. `configUpdate` disposes EVERY instance after any
 * accepted config write, so anybody changing a setting — in another window, on another device —
 * disconnected every live subscriber. A CLI turn mid-flight simply died; the desktop UI hid it by
 * reconnecting. Measured 2026-08-24: `notes/reports/attach-flake-2026-08-24.md`.
 *
 * ⚠️ **Ending the stream was never necessary, only assumed.** The subscription does NOT live inside
 * the instance: it listens on `EventV2Bridge`, which is GLOBAL-tagged precisely so one bus is shared
 * across locations, and it filters by `location.directory` — a string that is identical before and
 * after a rebuild. So a disposed-then-reloaded instance's events keep matching this subscriber's
 * filter. The stream had a reason to survive all along.
 *
 * The disposal is still DELIVERED — clients that refresh on it (the app's `event-reducer`) keep
 * working. What changes is that it is news, not a hang-up. It is the OS metaphor holding: config
 * changing is `SIGHUP`, and an operating system does not kill every process because a setting moved.
 *
 * The stream still ends when `live` ends — that is the request scope closing, which is a real
 * goodbye rather than an inferred one.
 */
export const subscriptionOutput = <A extends { readonly type: string }, E = never>(
  live: Stream.Stream<A, E>,
  disposals: Stream.Stream<A>,
): Stream.Stream<A, E> => live.pipe(Stream.merge(disposals, { haltStrategy: "left" }))

/**
 * How far one subscriber may fall behind before it is disconnected to resync.
 *
 * ⚠️ The SAME bound and the same overflow policy as `/global/event` next door: a healthy client
 * drains continuously, so reaching this means it has stopped reading rather than merely being slow.
 * Overflow ENDS the subscription instead of trimming it — `sliding`/`dropping` leave that one
 * client's view silently diverged, and `suspend` lets it apply backpressure to a bus every other
 * client shares. Ending is safe because a reconnect re-emits `server.connected` and the app resyncs.
 */
const EVENT_STREAM_BUFFER = 1024

/**
 * The bounded, source-filtered subscription this route serves.
 *
 * 🔴 **Two defects lived in one expression, and the second is what made the first unbounded in
 * practice.** The queue was `Queue.unbounded`, and the location predicate ran DOWNSTREAM of it — so
 * every subscriber buffered every event of every location in the process, without limit, and threw
 * almost all of it away one stage later. One stalled `run --attach` was enough to own the heap.
 *
 * ⚠️ **Once the queue is bounded, filtering at the SOURCE stops being an optimisation and becomes
 * the correctness of the bound.** Filtered after the queue, a subscriber watching a quiet directory
 * is disconnected by a busy neighbour's traffic it was never going to be shown — the bound would
 * measure the wrong stream.
 *
 * The bounding shape is `EventV2.allBounded`'s (`core/src/event.ts`), which `/api/event` already
 * uses: a dropping queue that FAILS on overflow rather than silently shedding — the failure travels
 * in the stream's error channel, so a forced disconnect is a report and not a silence. The only
 * thing added here is the predicate, applied before the offer. `capacity` is a parameter so a test
 * can reach the bound without publishing a thousand events.
 */
export const boundedSubscription = (
  events: EventV2.Interface,
  accepts: (event: EventV2.Payload) => boolean,
  capacity = EVENT_STREAM_BUFFER,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<EventV2.Payload, EventV2.SubscriberOverflowError>(capacity)
    const unsubscribe = yield* events.listen((event) =>
      !accepts(event)
        ? Effect.void
        : Queue.offer(queue, event).pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : Queue.fail(queue, new EventV2.SubscriberOverflowError({ capacity })).pipe(Effect.asVoid),
            ),
          ),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid))
    return Stream.fromQueue(queue)
  })

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const stream = (yield* boundedSubscription(
      events,
      (event) =>
        event.location?.directory === instance.directory &&
        (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID),
    )).pipe(Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })))
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(queue, {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = subscriptionOutput(stream, disposed)
    const heartbeat = Stream.tick("5 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Log.event("server.event.connected", {})
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Log.event("server.event.disconnected", {})),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
