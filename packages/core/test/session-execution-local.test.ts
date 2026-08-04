import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Layer } from "effect"
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
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionExecutionLocal } from "@novaclaw/core/session/execution/local"
import { SessionRunner } from "@novaclaw/core/session/runner/index"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

// The stale-"working" regression (owner report 2026-07-21): the server never published
// `session.status` busy/idle, so the app's optimistic submit-time busy was never cleared and a
// session looked "working" forever after its first turn (folder-move guard stuck). The drain in
// execution/local.ts is the authoritative seam: busy on start, idle on ANY settle — except after
// exit(result), where the K1 terminal `exited` must not be stomped.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionStore.node])))

const sessionID = "ses_0123456789abcdefghijklmn" as SessionSchema.ID

type Captured = { type: string; status: { type: string }; directory: string | undefined }

const harness = (input: {
  run: (setResult: (value: string) => void, sessionID: SessionSchema.ID) => Effect.Effect<void, never>
  children?: Readonly<Record<string, ReadonlyArray<SessionSchema.ID>>>
}) =>
  Effect.gen(function* () {
    const ref = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    let result: string | undefined
    const record = () => ({ id: sessionID, location: ref, result }) as unknown as SessionSchema.Info

    const storeLayer = Layer.succeed(SessionStore.Service, {
      get: () => Effect.succeed(record()),
      children: (id: SessionSchema.ID) => Effect.succeed(input.children?.[id] ?? []),
    } as unknown as SessionStore.Interface)
    const locatedLayer = Layer.mergeAll(
      Layer.succeed(
        SessionRunner.Service,
        SessionRunner.Service.of({ run: ({ sessionID: id }) => input.run((value) => (result = value), id) }),
      ),
      Layer.succeed(Location.Service, Location.Service.of(location(ref))),
    ) as unknown as Layer.Layer<LocationServices, LocationError>
    const mapLayer = Layer.succeed(LocationServiceMap.Service, {
      get: () => locatedLayer,
    } as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>)
    const attemptLayer = Layer.succeed(
      SessionExecutionAttempt.Service,
      SessionExecutionAttempt.Service.of({
        start: (id, ownerID) => Effect.succeed({ sessionID: id, ownerID, attemptID: "exe_test", generation: 1 }),
        heartbeat: () => Effect.void,
        advance: () => Effect.void,
        toolDispatched: () => Effect.void,
        toolSettled: () => Effect.void,
        providerStarted: () => Effect.void,
        providerToolProtocol: () => Effect.void,
        providerSettled: () => Effect.void,
        providerRecovery: () => Effect.succeed(undefined),
        settle: () => Effect.void,
        recoverFailure: () => Effect.succeed(undefined),
        get: () => Effect.succeed(undefined),
        list: () => Effect.succeed([]),
        authorizeRetry: () => Effect.void,
        owns: () => Effect.succeed(true),
        recoverStale: () => Effect.succeed([]),
      }),
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
      Layer.provide(attemptLayer),
      Layer.provide(Layer.succeed(EventV2.Service, events)),
    )
    const ctx = yield* Layer.build(execLayer)
    return { exec: Context.get(ctx, SessionExecution.Service), captured, directory: ref.directory }
  })

describe("SessionExecutionLocal status lifecycle", () => {
  it.effect("the store exposes direct children without folding grandchildren into the query", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const parent = SessionSchema.ID.make("ses_store_parent")
      const child = SessionSchema.ID.make("ses_store_child")
      const grandchild = SessionSchema.ID.make("ses_store_grandchild")
      yield* db
        .insert(SessionTable)
        .values([
          { id: parent, slug: "parent", directory: "/project", title: "parent", version: "test" },
          { id: child, slug: "child", directory: "/project", title: "child", version: "test", parent_id: parent },
          {
            id: grandchild,
            slug: "grandchild",
            directory: "/project",
            title: "grandchild",
            version: "test",
            parent_id: child,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const store = yield* SessionStore.Service
      expect(yield* store.children(parent)).toEqual([child])
      expect(yield* store.children(child)).toEqual([grandchild])
    }),
  )

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

  it.effect("stopping a session reaps its complete descendant tree and leaves unrelated work alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = SessionSchema.ID.make("ses_child")
        const grandchild = SessionSchema.ID.make("ses_grandchild")
        const sibling = SessionSchema.ID.make("ses_sibling")
        const unrelated = SessionSchema.ID.make("ses_unrelated")
        const started = yield* Deferred.make<void>()
        const running = new Set<SessionSchema.ID>()
        const interrupted: SessionSchema.ID[] = []
        const h = yield* harness({
          children: {
            [sessionID]: [child, sibling],
            [child]: [grandchild],
            // Corrupt ancestry must terminate rather than turning Stop into an infinite walk.
            [grandchild]: [sessionID],
          },
          run: (_setResult, id) =>
            Effect.sync(() => {
              running.add(id)
              return running.size
            }).pipe(
              Effect.flatMap((size) => (size === 5 ? Deferred.succeed(started, undefined) : Effect.void)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  running.delete(id)
                  interrupted.push(id)
                }),
              ),
            ),
        })

        yield* Effect.forEach([sessionID, child, grandchild, sibling, unrelated], h.exec.wake, {
          discard: true,
        })
        yield* Deferred.await(started)

        yield* h.exec.interrupt(sessionID)

        expect(new Set(interrupted)).toEqual(new Set([sessionID, child, grandchild, sibling]))
        expect(Array.from(yield* h.exec.active)).toEqual([unrelated])
        yield* h.exec.interrupt(unrelated)
      }),
    ),
  )
})
