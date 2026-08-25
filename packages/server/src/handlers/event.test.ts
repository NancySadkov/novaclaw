import { describe, expect, test } from "bun:test"
import { EventV2 } from "@novaclaw/core/event"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { Catalog } from "@novaclaw/schema/catalog"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { Effect, Fiber, Stream } from "effect"
import { publicEventStream } from "./event"

/**
 * `/api/event` is the public event stream, and until 2026-08-25 ONE ordinary instance event took it
 * down.
 *
 * The bus carries `EventManifest.Definitions`; the route's declared wire union is
 * `ServerDefinitions` ∪ `server.connected`, about twenty types narrower. The handler encoded every
 * bus event with `Schema.encodeUnknownSync`, which THROWS on a non-member — a defect inside
 * `Stream.map`, so the response body ended. Measured against a plain `serve`: a subscriber saw
 * `server.connected`, then `session.created`, and the stream closed 0.1 s after a prompt was
 * admitted, when the run's first `session.status` reached it. No `session.next.*` ever arrived and
 * nothing was logged, which is exactly the "the instance publishes no session events" report.
 *
 * ⚠️ **The killer must be a REAL non-member, taken from the manifests at run time.** A hand-written
 * fake type would prove the filter rejects strings nobody publishes; {@link OFFENDER} is asserted to
 * be a type the instance genuinely emits and the wire genuinely cannot express, so the day someone
 * widens `ServerDefinitions` this file says so instead of testing a fiction.
 *
 * ⚠️ **Every absence below is paired with a presence IN THE SAME RUN.** A test that only asserts
 * "the offender did not appear" passes just as well on a stream that delivered nothing at all —
 * which is the very failure being fixed.
 */

/** A type the instance publishes that the public wire union cannot carry. */
const OFFENDER = SessionStatusEvent.Status

/**
 * A type the wire union CAN carry, used on both sides of the offender.
 *
 * Non-durable on purpose: a durable control would drag aggregate sequencing into a test whose claim
 * is about ENCODING, and a failure there would read as the defect under test.
 */
const CARRIED = Catalog.Event.Updated

const wireTypes = new Set(EventManifest.ServerDefinitions.map((one) => one.type))

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]))

const run = <A>(effect: Effect.Effect<A, unknown, EventV2.Service | Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<A>)

describe("the public event stream's manifest asymmetry", () => {
  test("the fixture is real: the offender is published but unwireable, the control is wireable", () => {
    const published = new Set(EventManifest.Definitions.map((one) => one.type))
    expect(published.has(OFFENDER.type)).toBe(true)
    expect(wireTypes.has(OFFENDER.type)).toBe(false)
    expect(wireTypes.has(CARRIED.type)).toBe(true)
  })

  test("an event outside the wire union is skipped and the stream keeps delivering", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const stream = yield* publicEventStream(events)
        // Take three: `server.connected`, then the two carried events that straddle the offender.
        // If the offender kills the stream this never reaches three and the take times out.
        const collecting = yield* Effect.forkScoped(stream.pipe(Stream.take(3), Stream.runCollect))
        yield* Effect.yieldNow

        yield* events.publish(CARRIED, {})
        yield* events.publish(OFFENDER, { sessionID: "ses_probe" as never, status: { type: "idle" } } as never)
        yield* events.publish(CARRIED, {})

        const frames = yield* Fiber.join(collecting)
        return Array.from(frames).map((frame) => JSON.parse(frame.data as string) as { type: string })
      }),
    )

    // PRESENCE — the stream survived the offender and delivered what came after it.
    expect(seen.map((one) => one.type)).toEqual(["server.connected", CARRIED.type, CARRIED.type])
    // ABSENCE — and the offender itself never reached a client that cannot parse it.
    expect(seen.some((one) => one.type === OFFENDER.type)).toBe(false)
  }, 20_000)
})
