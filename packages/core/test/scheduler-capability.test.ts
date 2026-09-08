import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { CalendarScheduler } from "@novaclaw/core/schedule/scheduler"

/**
 * Fault-injection for the SCHEDULER edge — `` §1: *"Boot reaches a usable shell
 * when KB, scheduler, telemetry, updates, sidecar, or one provider fails."*
 *
 * ⚠️ The capability-wrapped scheduler is the CALENDAR one (`schedule/scheduler.ts`), not
 * `SessionScheduler` — two modules, similar names, and only one sits behind an edge. Aiming at the
 * wrong one produces a test that cannot fail for the reason it claims.
 *
 * KB already had this test (`kb-graph-memory-capability.test.ts`); the scheduler did not, so the
 * claim rested on the two subsystems sharing a mechanism rather than on the scheduler being tried.
 * A capability edge is easy to attach and easy to attach WRONGLY — a node wired outside
 * `LayerNode.capability`, or acquired eagerly by something at boot, fails the whole graph while
 * still looking correct in review.
 *
 * ⚠️ The assertion that matters most is `state: "idle"` with zero builds. "Survives a failure" is
 * cheap; what makes the edge worth having is that merely BOOTING does not touch the subsystem at
 * all, so a broken scheduler costs nothing until something asks for it.
 */
describe("scheduler capability", () => {
  test("a poisoned scheduler cannot kill boot, and boot does not even build it", async () => {
    let refuse = true
    let builds = 0
    const poisoned = Layer.effect(
      CalendarScheduler.Service,
      Effect.sync(() => {
        builds++
        if (refuse) throw new Error("forced scheduler boot defect")
        return CalendarScheduler.Service.of({} as never)
      }),
    )
    const graph = AppNodeBuilder.build(LayerNode.group([CalendarScheduler.capabilityNode]), [
      [CalendarScheduler.node, poisoned],
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const capability = yield* CalendarScheduler.capabilityNode.service

        // Booting the graph must not acquire it. A scheduled-work subsystem that is built eagerly
        // turns "my calendar backend is broken" into "the app will not start".
        expect(yield* capability.status).toEqual({ state: "idle" })
        expect(builds).toBe(0)

        // First demand turns the defect into a NAMED value rather than a thrown boot failure.
        const result = yield* capability.get
        expect(result.ok).toBe(false)
        expect(yield* capability.status).toMatchObject({
          state: "unavailable",
          reason: { capability: "calendar-scheduler", kind: "failed" },
          attempts: 1,
        })

        // Cached: a broken subsystem must not be retried on every call, or a failing edge becomes a
        // retry storm against whatever it depends on.
        yield* capability.get
        expect(builds).toBe(1)

        // Repairable in place — no restart, no graph rebuild.
        refuse = false
        expect(yield* capability.retry).toMatchObject({ state: "ready" })
        expect(builds).toBe(2)
      }).pipe(Effect.provide(graph)),
    )
  })

  /**
   * NEGATIVE CONTROL. Without it the test above is unfalsifiable: a poison that could not kill a
   * boot in the first place would produce exactly the same green, and so would a capability edge
   * that had been quietly removed. This pins that the SAME layer, wired WITHOUT the edge, does take
   * the graph down — so the passing test above is measuring the edge and nothing else.
   */
  test("the same defect, wired without the capability edge, does kill the boot", async () => {
    const poisoned = Layer.effect(
      CalendarScheduler.Service,
      Effect.sync((): never => {
        throw new Error("forced scheduler boot defect")
      }),
    )
    const graph = AppNodeBuilder.build(LayerNode.group([CalendarScheduler.node]), [[CalendarScheduler.node, poisoned]])

    // ⚠️ A constructor that THROWS produces a defect, not a typed failure — `Effect.match` and
    // `catchAll` sail straight past it. That is the whole reason the capability edge has to exist:
    // ordinary error handling around a boot node would not have caught this.
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* CalendarScheduler.Service
      }).pipe(Effect.provide(graph)),
    ).then(
      () => "survived",
      () => "died",
    )
    expect(outcome).toBe("died")
  })
})
