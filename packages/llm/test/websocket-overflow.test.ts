import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"

import { fromWebSocket } from "../src/route/transport/websocket"

/**
 * 🔴 NC-REL-004 — the WebSocket receive queue is bounded at 128 and `Queue.offerUnsafe` DISCARDS the
 * item when it is full, returning `false`. Both call sites ignored that return. Probed against the
 * installed Effect: a queue of 2 answers `[true, true, false]`.
 *
 * So a reader that fell behind lost model deltas silently, and the stream it produced — missing text,
 * missing tool-call fragments — was handed on as a finished response. Silent corruption of an answer
 * is worse than a failure: a loud, retryable transport error is recoverable, a plausible wrong reply
 * is not.
 *
 * A/B: restore `Queue.offerUnsafe(messages, event.data)` without checking its return and this test
 * hangs or resolves with a short, complete-looking stream instead of failing.
 */
class FakeSocket extends EventTarget {
  readyState = 1 // OPEN
  close() {
    this.readyState = 3
  }
  send() {}
  emit(data: string) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }))
  }
}

describe("the WebSocket receive queue", () => {
  test("🔴 overflowing FAILS the stream — it does not drop a model frame in silence", async () => {
    const socket = new FakeSocket()
    const connection = await Effect.runPromise(
      fromWebSocket(
        socket as unknown as globalThis.WebSocket,
        {
          url: "wss://model.example/stream",
        } as never,
      ),
    )

    // Nothing is draining: the queue holds 128, so frame 129 has nowhere to go.
    for (let i = 0; i < 200; i++) socket.emit(`frame-${i}`)

    /**
     * ⚠️ Bounded on purpose. With the bug restored the collect never settles — nothing fails the
     * queue and nothing ends it — so this test HUNG instead of failing, which is the worst shape a
     * regression guard can take in a gate that wall-clock-kills. A timeout turns "reintroduced the
     * bug" into a fast, legible failure.
     */
    const outcome = await Effect.runPromise(
      Effect.exit(Stream.runCollect(connection.messages).pipe(Effect.timeout(2000))),
    )
    expect(outcome._tag).toBe("Failure")
    expect(JSON.stringify(outcome)).toContain("overflow")
  })

  test("a stream that stays inside the bound delivers every frame", async () => {
    // The control: without it, "always fail" would satisfy the test above while breaking every
    // healthy stream.
    const socket = new FakeSocket()
    const connection = await Effect.runPromise(
      fromWebSocket(
        socket as unknown as globalThis.WebSocket,
        {
          url: "wss://model.example/stream",
        } as never,
      ),
    )
    for (let i = 0; i < 10; i++) socket.emit(`frame-${i}`)
    // 1000 is the clean-close code the transport ends the queue on; a bare `close` Event has no
    // code and is correctly treated as a fault.
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }))

    const frames = await Effect.runPromise(Stream.runCollect(connection.messages))
    expect([...frames]).toHaveLength(10)
  })
})
