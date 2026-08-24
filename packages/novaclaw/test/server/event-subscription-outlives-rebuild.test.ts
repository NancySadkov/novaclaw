import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { subscriptionOutput } from "@/server/routes/instance/httpapi/handlers/event"

/**
 * An event subscription must survive an instance being rebuilt.
 *
 * This pins the seam that WAS the `attach mode` flake: the SSE output used to
 * `Stream.takeUntil` on `server.instance.disposed`, and `configUpdate` disposes every instance after
 * any accepted config write — so one person changing a setting disconnected every live subscriber.
 * See `notes/reports/attach-flake-2026-08-24.md`.
 */

type Event = { readonly type: string }

const collect = <A>(stream: Stream.Stream<A>) => Stream.runCollect(stream)

describe("an event subscription outlives an instance rebuild", () => {
  test("a disposal does not end the stream", async () => {
    const live = Stream.fromIterable<Event>([
      { type: "session.created" },
      { type: "server.instance.disposed" },
      { type: "session.updated" },
    ])
    const seen = await Effect.runPromise(collect(subscriptionOutput(live, Stream.never)))
    // The event AFTER the disposal is the whole point: with takeUntil it never arrived, and the
    // client was disconnected mid-turn.
    expect(seen.map((event) => event.type)).toEqual(["session.created", "server.instance.disposed", "session.updated"])
  })

  test("the disposal is still DELIVERED, not swallowed", async () => {
    // Clients refresh on it (the app's event-reducer). Silencing it would trade one defect for
    // another: a stream that survives but never says the instance was rebuilt.
    const live = Stream.fromIterable<Event>([{ type: "server.instance.disposed" }])
    const seen = await Effect.runPromise(collect(subscriptionOutput(live, Stream.never)))
    expect(seen.map((event) => event.type)).toEqual(["server.instance.disposed"])
  })

  test("the stream ends when the LIVE side ends — a real goodbye, not an inferred one", async () => {
    const live = Stream.fromIterable<Event>([{ type: "session.created" }])
    // `disposals` never ends on its own; if it governed completion this would hang rather than
    // return, so the assertion is that it does not.
    const seen = await Effect.runPromise(collect(subscriptionOutput(live, Stream.never)))
    expect(seen).toHaveLength(1)
  })
})
