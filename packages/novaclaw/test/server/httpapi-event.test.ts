import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

/**
 * SSE framing state per stream. A `Uint8Array` off the wire is a CHUNK, not a record: it may hold
 * several events, or half of one, and the split is the network's choice rather than the server's.
 *
 * ⚠️ This replaces `JSON.parse(decode(oneChunk).replace(/^data: /, ""))`, which assumed exactly one
 * complete `data:` line per chunk. That held only while the stream was sparse enough that each event
 * got its own packet — so it was never CORRECT, only lucky, and it failed the moment
 * `session.create` began emitting on a request that resolves a location (2026-08-07). The failure
 * mode is maximally misleading: `SyntaxError: Unable to parse JSON string`, which reads like the
 * server sent something malformed.
 *
 * Same framing as `httpapi-v2-location.test.ts`'s `eventStream` — records end at a blank line, and
 * `data:` lines within a record join with newlines.
 */
const buffers = new WeakMap<Queue.Dequeue<Uint8Array>, string>()

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    while (true) {
      const buffer = buffers.get(reader) ?? ""
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (boundary?.index !== undefined) {
        buffers.set(reader, buffer.slice(boundary.index + boundary[0].length))
        const data = buffer
          .slice(0, boundary.index)
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        // A record with no `data:` line is a comment or keepalive — skip it rather than parse "".
        if (data) return Schema.decodeUnknownSync(EventData)(JSON.parse(data))
        continue
      }
      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for event")),
        }),
      )
      buffers.set(reader, buffer + decoder.decode(value, { stream: true }))
    }
  })

/**
 * Read forward until an event of `type` arrives.
 *
 * ⚠️ **"The next event is the one I caused" is not a safe assumption on this stream** — it is an
 * INSTANCE-wide bus, so anything the request touches publishes onto it too. Asserting on the next
 * event tied the test to the current event volume of an unrelated subsystem: once `session.create`
 * began resolving a location (2026-08-07), booting that location graph emitted `plugin.added` first
 * and the test failed while the behaviour it covers was working. `httpapi-v2-location.test.ts` has
 * the same helper for the same reason.
 *
 * Bounded rather than looping forever, so a type that never arrives fails as a test rather than
 * hanging until the suite's wall-clock kill.
 */
const readEventType = (reader: Queue.Dequeue<Uint8Array>, type: string) =>
  Effect.gen(function* () {
    for (let index = 0; index < 20; index++) {
      const event = yield* readEvent(reader)
      if (event.type === type) return event
    }
    return yield* Effect.fail(new Error(`saw 20 events without ${type}`))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffectShared(httpApiLayer)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // ⚠️ `POST /session` — the bare V1 facade — was removed by the V1 nuke and 404s; there is no
        // `session` group in the HttpApi at all. This test is about EVENT DELIVERY, not session
        // creation, so only the trigger was stale: the native V2 route is the one that still
        // publishes `session.created`. (Pinned as Windows flakiness until 2026-08-06.)
        const created = yield* requestInDirectory("/api/session", directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "build", location: { directory } }),
        })
        expect(created.status).toBe(200)
        expect(yield* readEventType(reader, "session.created")).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false } },
  )
})
