import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"

/**
 * Fault-injection for the MESSENGER edge — `` §1.
 *
 * The gateway is the edge most likely to actually break in the field: it holds a live network
 * session against someone else's service, and it is the one subsystem here whose failure mode is
 * routine rather than exceptional. `messenger-gateway.test.ts` covers what an `unavailable` SEND
 * reports; nothing covered a gateway that cannot be CONSTRUCTED, which is a different failure at a
 * different time — before anyone has asked for anything.
 *
 * ⚠️ Use the singleton `node` / `capabilityNode`, never `nodeWith()` / `capabilityNodeWith()`.
 * Effect's MemoMap is keyed on layer object identity, so calling the `…With` form mints a fresh key
 * and the replacement would bind to a node the graph never builds — a test that passes while
 * exercising nothing.
 */
describe("messenger capability", () => {
  test("a gateway that cannot be constructed does not reach boot, and repairs in place", async () => {
    let refuse = true
    let builds = 0
    const poisoned = Layer.effect(
      MessengerGateway.Service,
      Effect.sync(() => {
        builds++
        if (refuse) throw new Error("forced messenger boot defect")
        return MessengerGateway.Service.of({} as never)
      }),
    )
    const graph = AppNodeBuilder.build(LayerNode.group([MessengerGateway.capabilityNode]), [
      [MessengerGateway.node, poisoned],
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const capability = yield* MessengerGateway.capabilityNode.service

        // Idle at boot with zero builds: a person who has never linked a messenger account must not
        // pay for one, and a broken link must not be discovered by the app failing to start.
        expect(yield* capability.status).toEqual({ state: "idle" })
        expect(builds).toBe(0)

        const result = yield* capability.get
        expect(result.ok).toBe(false)
        expect(yield* capability.status).toMatchObject({
          state: "unavailable",
          reason: { capability: "messenger", kind: "failed" },
          attempts: 1,
        })

        // Cached. A messenger gateway retried on every call is a reconnect storm against a
        // third-party service, which is how an account gets rate-limited or locked.
        yield* capability.get
        expect(builds).toBe(1)

        refuse = false
        expect(yield* capability.retry).toMatchObject({ state: "ready" })
        expect(builds).toBe(2)
      }).pipe(Effect.provide(graph)),
    )
  })
})
