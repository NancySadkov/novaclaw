import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import type { LayerMap } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import type { LocationError, LocationServices } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionExecutionLocal } from "@novaclaw/core/session/execution/local"
import { SessionRunner } from "@novaclaw/core/session/runner/index"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

// The stale-"working" regression (owner report 2026-07-21): the server never published
// `session.status` busy/idle, so the app's optimistic submit-time busy was never cleared and a
// session looked "working" forever after its first turn (folder-move guard stuck). The drain in
// execution/local.ts is the authoritative seam: busy on start, idle on ANY settle — except after
// exit(result), where the K1 terminal `exited` must not be stomped.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

const sessionID = "ses_0123456789abcdefghijklmn" as SessionSchema.ID

type Captured = { type: string; status: { type: string }; directory: string | undefined }

const harness = (input: {
  run: (setResult: (value: string) => void) => Effect.Effect<void, never>
}) =>
  Effect.gen(function* () {
    const ref = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    let result: string | undefined
    const record = () => ({ id: sessionID, location: ref, result }) as unknown as SessionSchema.Info

    const storeLayer = Layer.succeed(
      SessionStore.Service,
      { get: () => Effect.succeed(record()) } as unknown as SessionStore.Interface,
    )
    const locatedLayer = Layer.mergeAll(
      Layer.succeed(
        SessionRunner.Service,
        SessionRunner.Service.of({ run: () => input.run((value) => (result = value)) }),
      ),
      Layer.succeed(Location.Service, Location.Service.of(location(ref))),
    ) as unknown as Layer.Layer<LocationServices, LocationError>
    const mapLayer = Layer.succeed(
      LocationServiceMap.Service,
      { get: () => locatedLayer } as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>,
    )

    const events = yield* EventV2.Service
    const captured: Captured[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type !== "session.status") return
        const data = event.data as { status: { type: string } }
        captured.push({ type: event.type, status: data.status, directory: event.location?.directory })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    const execLayer = SessionExecutionLocal.layer.pipe(
      Layer.provide(storeLayer),
      Layer.provide(mapLayer),
      Layer.provide(Layer.succeed(EventV2.Service, events)),
    )
    const ctx = yield* Layer.build(execLayer)
    return { exec: Context.get(ctx, SessionExecution.Service), captured, directory: ref.directory }
  })

describe("SessionExecutionLocal status lifecycle", () => {
  it.effect("publishes busy then idle around a successful drain, location-stamped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ run: () => Effect.void })
        yield* h.exec.resume(sessionID)
        expect(h.captured.map((c) => c.status.type)).toEqual(["busy", "idle"])
        for (const item of h.captured) expect(item.directory).toBe(h.directory)
      }),
    ),
  )

  it.effect("still settles to idle when the drain dies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ run: () => Effect.die("boom") as Effect.Effect<void, never> })
        yield* h.exec.resume(sessionID).pipe(Effect.exit)
        expect(h.captured.map((c) => c.status.type)).toEqual(["busy", "idle"])
      }),
    ),
  )

  it.effect("does not stomp the terminal exited state after exit(result)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ run: (setResult) => Effect.sync(() => setResult("done")) })
        yield* h.exec.resume(sessionID)
        // exit.ts publishes `exited` itself; the drain must not follow with idle.
        expect(h.captured.map((c) => c.status.type)).toEqual(["busy"])
      }),
    ),
  )
})
