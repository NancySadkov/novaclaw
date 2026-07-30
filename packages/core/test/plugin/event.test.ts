import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Logger } from "effect"
import { Catalog } from "@novaclaw/schema/catalog"
import { ModelsDev } from "@novaclaw/schema/models-dev"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginHost } from "@novaclaw/core/plugin/host"
import { PluginPromise } from "@novaclaw/core/plugin/promise"
import { AbsolutePath } from "@novaclaw/core/schema"
import { define } from "@novaclaw/plugin/v2/promise"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

/**
 * Wait on a delivery barrier — but NEVER forever.
 *
 * These cases run on `it.live` (a real clock) precisely so this bound is real: a regression must
 * FAIL in five seconds, not wedge. Measured while negative-controlling this file: a plain
 * `Deferred.await` on a barrier that never opens does not merely fail the one test — the pending
 * fiber keeps the bun process alive past bun's own per-test timeout, so the run produces no
 * output at all and has to be killed. A test that hangs is worse than a test that cannot fail.
 */
const arrives = (deferred: Deferred.Deferred<void>, what: string) =>
  Deferred.await(deferred).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
    }),
  )

/**
 * Give every runnable fiber a generous chance to make progress before asserting a NEGATIVE.
 *
 * Delivery is a forked pump per subscription, so "nothing arrived" is only meaningful once the
 * scheduler has had the opportunity to deliver. Each negative test below is additionally gated
 * on a live sibling subscription's barrier, so the publish has demonstrably been through the
 * listener list before this runs.
 */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 25; index++) yield* Effect.yieldNow
})

/** Collect every WARN emitted while an effect runs — including from fibers it forks. */
const collectWarnings = () => {
  const warnings: string[] = []
  const collector = Logger.make((options: Logger.Options<unknown>) => {
    if (options.logLevel !== "Warn") return
    warnings.push(Array.isArray(options.message) ? options.message.map(String).join(" ") : String(options.message))
  })
  return { warnings, layer: Logger.layer([collector]) }
}

/** A handler that records the event ids it is given and opens `done` on the `until`-th one. */
const recorder = (until: number) =>
  Effect.gen(function* () {
    const seen: string[] = []
    const done = yield* Deferred.make<void>()
    const handler = (event: { readonly id: string }) =>
      Effect.gen(function* () {
        seen.push(event.id)
        if (seen.length >= until) yield* Deferred.succeed(done, undefined)
      })
    return { seen, done, handler }
  })

/** The same, but it throws on every delivery — after recording and signalling. */
const explodingRecorder = (until: number) =>
  Effect.gen(function* () {
    const seen: string[] = []
    const done = yield* Deferred.make<void>()
    const handler = (event: { readonly id: string }) =>
      Effect.gen(function* () {
        seen.push(event.id)
        if (seen.length >= until) yield* Deferred.succeed(done, undefined)
        throw new Error("plugin event handler exploded")
      })
    return { seen, done, handler }
  })

describe("PluginHost event domain", () => {
  it.live("delivers an event of the subscribed type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      const target = yield* recorder(1)

      yield* host.event.subscribe("catalog.updated", target.handler)
      const published = yield* events.publish(Catalog.Event.Updated, {})

      yield* arrives(target.done, "the subscribed event")
      expect(target.seen).toEqual([published.id])
    }),
  )

  it.live("does not deliver an event of another type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      const target = yield* recorder(1)

      yield* host.event.subscribe("catalog.updated", target.handler)
      yield* events.publish(ModelsDev.Event.Refreshed, {})
      const wanted = yield* events.publish(Catalog.Event.Updated, {})

      yield* arrives(target.done, "the subscribed event type")
      yield* settle
      expect(target.seen).toEqual([wanted.id])
    }),
  )

  it.live("does not deliver another location's event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const location = yield* Location.Service
      const host = yield* PluginHost.make(plugin)
      const target = yield* recorder(1)

      const elsewhere = Location.Ref.make({
        directory: AbsolutePath.make(`${location.directory}-elsewhere`),
      })

      yield* host.event.subscribe("catalog.updated", target.handler)
      const foreign = yield* events.publish(Catalog.Event.Updated, {}, { location: elsewhere })
      const mine = yield* events.publish(Catalog.Event.Updated, {})

      // The fixture is only a real test if the foreign publish actually carried the foreign
      // location — assert that rather than trusting it.
      expect(foreign.location?.directory).toBe(elsewhere.directory)
      expect(mine.location?.directory).toBe(location.directory)

      yield* arrives(target.done, "this location's event")
      yield* settle
      expect(target.seen).toEqual([mine.id])
    }),
  )

  // The V1 bug, pinned. V1 filtered on `event.location?.directory !== ctx.directory`, which
  // dropped every event with NO location — i.e. every genuinely instance-global event, because
  // `location` is only stamped when `Location.Service` is in the publisher's scope. A global
  // event is nobody else's data, so dropping it was wrong; it belongs to every plugin.
  it.live("delivers a location-less global event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      const target = yield* recorder(1)

      yield* host.event.subscribe("models-dev.refreshed", target.handler)
      // Publish the way a GLOBAL service does: with no `Location.Service` in scope, so the
      // payload carries no location at all.
      const global = yield* events
        .publish(ModelsDev.Event.Refreshed, {})
        .pipe(
          Effect.updateContext((context: Context.Context<Location.Service>) => Context.omit(Location.Service)(context)),
        )

      expect(global.location).toBeUndefined()

      yield* arrives(target.done, "the location-less global event")
      expect(target.seen).toEqual([global.id])
    }),
  )

  it.live("a throwing handler kills neither its own subscription nor a neighbour's", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      const noisy = yield* explodingRecorder(2)
      const quiet = yield* recorder(2)

      yield* host.event.subscribe("catalog.updated", noisy.handler)
      yield* host.event.subscribe("catalog.updated", quiet.handler)

      const first = yield* events.publish(Catalog.Event.Updated, {})
      const second = yield* events.publish(Catalog.Event.Updated, {})

      yield* arrives(noisy.done, "the throwing handler's second delivery")
      yield* arrives(quiet.done, "the neighbouring handler's second delivery")
      // The thrower saw BOTH: its own subscription survived its first failure.
      expect(noisy.seen).toEqual([first.id, second.id])
      // And the plugin registered AFTER it saw both too — V1's `for` loop over `void hook(...)`
      // aborted here and starved every later plugin.
      expect(quiet.seen).toEqual([first.id, second.id])
    }),
  )

  it.live("dispose ends the subscription", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      const target = yield* recorder(1)
      const barrier = yield* recorder(2)

      const registration = yield* host.event.subscribe("catalog.updated", target.handler)
      yield* host.event.subscribe("catalog.updated", barrier.handler)

      const before = yield* events.publish(Catalog.Event.Updated, {})
      yield* arrives(target.done, "the pre-dispose event")
      expect(target.seen).toEqual([before.id])

      yield* registration.dispose
      const after = yield* events.publish(Catalog.Event.Updated, {})

      yield* arrives(barrier.done, "the post-dispose event on the live sibling")
      yield* settle
      expect(barrier.seen).toEqual([before.id, after.id])
      expect(target.seen).toEqual([before.id])
    }),
  )

  it.live("delivers to a Promise-flavored plugin end to end", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      const seen: string[] = []
      let arrive = () => {}
      // A plain promise, on purpose: this is the flavor whose whole point is that a plugin
      // author never touches Effect.
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve
      })

      const promisePlugin = define({
        id: "event-promise",
        setup: async (ctx) => {
          await ctx.event.subscribe("catalog.updated", async (event) => {
            seen.push(event.id)
            arrive()
          })
        },
      })

      yield* PluginPromise.fromPromise(promisePlugin).effect(host)
      const published = yield* events.publish(Catalog.Event.Updated, {})

      yield* Effect.promise(() => arrived).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.die(new Error("timed out waiting for the Promise-flavored plugin's delivery")),
        }),
      )
      expect(seen).toEqual([published.id])
    }),
  )

  // Ruling 2 — a fault is never described falsely. `server.instance.disposed` is in the public
  // SDK union but is emitted by the instance supervisor, not the kernel bus, so a subscription
  // to it can never fire. Registering it silently would leave the plugin deaf with no way to
  // find out.
  it.live("warns rather than registering a silently deaf subscription", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      const target = yield* recorder(1)

      const unpublishable = collectWarnings()
      yield* host.event.subscribe("server.instance.disposed", target.handler).pipe(Effect.provide(unpublishable.layer))
      expect(unpublishable.warnings.some((line) => line.includes("the kernel never publishes"))).toBe(true)

      // …and a type the kernel DOES publish is silent, so the assertion above is not vacuous.
      const ordinary = collectWarnings()
      yield* host.event.subscribe("catalog.updated", target.handler).pipe(Effect.provide(ordinary.layer))
      expect(ordinary.warnings.some((line) => line.includes("the kernel never publishes"))).toBe(false)
    }),
  )

  // D2's back-pressure half: a wedged handler costs a BOUNDED amount of memory, and the loss is
  // logged rather than silent. V1 had no bound at all, and every typed PubSub is unbounded.
  it.live("drops — loudly — once a wedged handler falls past the buffer", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      const { warnings, layer } = collectWarnings()

      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const wedged = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        })

      yield* host.event.subscribe("catalog.updated", wedged)
      // One event, awaited, so the pump is provably inside the handler and takes nothing more.
      yield* events.publish(Catalog.Event.Updated, {})
      yield* arrives(started, "the wedged handler to take its first event")

      // The listener — and therefore the drop log — runs in the PUBLISHING fiber, so the
      // collector has to wrap the publishes, not the subscribe.
      const flood = 300
      yield* Effect.gen(function* () {
        for (let index = 0; index < flood; index++) yield* events.publish(Catalog.Event.Updated, {})
      }).pipe(Effect.provide(layer))

      const dropped = warnings.filter((line) => line.includes("Plugin event dropped"))
      // Bounded, not lossless: some were dropped…
      expect(dropped.length).toBeGreaterThan(0)
      // …and bounded, not broken: the buffer really did absorb a few hundred first.
      expect(dropped.length).toBeLessThan(flood)

      yield* Deferred.succeed(release, undefined)
    }),
  )
})
