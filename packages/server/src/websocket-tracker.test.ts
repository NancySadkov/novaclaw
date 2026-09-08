import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { WebSocketTracker } from "./websocket-tracker"

describe("listener WebSocket ownership", () => {
  test("shutdown requests a going-away close with a legible reason", () => {
    const event = WebSocketTracker.SERVER_CLOSING_EVENT()
    expect(event.code).toBe(1001)
    expect(event.reason).toBe("server closing")
  })

  test("closes each live socket once, unregisters detached sockets, and refuses late sockets", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* WebSocketTracker.Service
          let live = 0
          let detached = 0
          const liveScope = yield* Scope.make()
          const detachedScope = yield* Scope.make()
          expect(
            yield* Scope.provide(
              WebSocketTracker.register(
                Effect.sync(() => {
                  live++
                }),
              ),
              liveScope,
            ),
          ).toBe(true)
          expect(
            yield* Scope.provide(
              WebSocketTracker.register(
                Effect.sync(() => {
                  detached++
                }),
              ),
              detachedScope,
            ),
          ).toBe(true)
          yield* Scope.close(detachedScope, Exit.void)
          yield* tracker.closeAll
          yield* tracker.closeAll
          expect(live).toBe(1)
          expect(detached).toBe(0)
          expect(yield* WebSocketTracker.register(Effect.void)).toBe(false)
          yield* Scope.close(liveScope, Exit.void)
        }),
      ).pipe(Effect.provide(WebSocketTracker.layer)),
    )
  })

  test("a stuck close cannot hold shutdown indefinitely", async () => {
    const start = Date.now()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* WebSocketTracker.Service
          yield* WebSocketTracker.register(Effect.never)
          yield* tracker.closeAll
        }),
      ).pipe(Effect.provide(WebSocketTracker.layer), Effect.timeout("2 seconds")),
    )
    expect(Date.now() - start).toBeLessThan(2_000)
  })
})
