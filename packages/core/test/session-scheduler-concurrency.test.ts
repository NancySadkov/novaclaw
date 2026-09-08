import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { ProviderDispatch } from "@novaclaw/core/session/runner/provider-dispatch"
import { MAX_BATCH, make } from "@novaclaw/core/session/scheduler"

/**
 * Concurrency hazards on the device admission gate, driven through the REAL scheduler.
 *
 * 🔴 The defect these exist for, measured 2026-08-20. A parent spawned a child and called `wait`.
 * The child's first step began **599.3 s** later, against a join timeout of 600 s; every later step
 * took 0.0–3.0 s and the parent's own steps ran at 1.5 s on the same warm model — which cold-loads
 * in 288 s. The child was never slow. It was never admitted.
 *
 *   · a sub-agent is BATCH class, admitted only while `inFlightInteractive` is empty;
 *   · the parent is INTERACTIVE and holds the device from `admit` until `release`;
 *   · `release` was only the `ensuring` net at the end of dispatch — after settlement, which is
 *     where tools RUN. So the parent held the device against the child it was waiting for, and the
 *     cycle broke only when the join gave up.
 *
 * Both halves of the correct design were already written down — `provider-dispatch.ts`'s header
 * ("the slot covers GENERATION only … the deadlock the bracket placement exists to prevent") and
 * `scheduler.release`'s comment ("runs twice per turn (in-band, then the `ensuring` net)"). The
 * in-band release simply did not exist. These tests are what makes its absence fail loudly.
 *
 * ⚠️ Everything below uses REAL fibers and the REAL gate. A concurrency test against a mock proves
 * the mock is consistent with itself.
 */

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
/** Let queued fibers make progress without pinning the test to a wall clock. */
const tick = () => run(Effect.yieldNow.pipe(Effect.andThen(Effect.sleep("20 millis"))))

/**
 * Fork an effect and expose whether it has COMPLETED.
 *
 * A flag set inside the effect, rather than polling the fiber: it records that admission actually
 * returned, which is the thing under test — a fiber can finish for reasons that are not admission.
 */
const forkTracked = <A>(effect: Effect.Effect<A>) => {
  const state = { done: false }
  const fiber = Effect.runFork(effect.pipe(Effect.map((a) => ((state.done = true), a))))
  return { fiber, state }
}

const slotFor = (sessionID: string, sessionClass: string) => ({ sessionID, deviceKey: "spark", sessionClass }) as never
const events = { publish: () => Effect.void } as never

describe("the parent/child deadlock — a join must not hold the device against its own child", () => {
  test("a batch child is admitted while its interactive parent is still SETTLING", async () => {
    // The exact shape of the measured failure: the parent's generation is over, but its turn is not
    // — it is inside the `wait` tool. That is precisely when the child needs the device.
    const gate = make()
    const toolBlocking = Deferred.makeUnsafe<void>()

    const parent = forkTracked(
      ProviderDispatch.runAndSettle(
        {
          events,
          scheduler: gate,
          sessionID: "parent" as never,
          slot: slotFor("parent", "interactive"),
          maxAttempts: 1,
          hasOutput: () => false,
          attempt: Effect.void,
        },
        // `settle` is where tools run. This one blocks, standing in for `wait`.
        () => Deferred.await(toolBlocking),
      ),
    )
    await tick()

    const child = forkTracked(gate.admit(slotFor("child", "sub-agent")))
    await tick()

    // ⭐ THE ASSERTION. Before the fix this was false, and stayed false until the join timed out.
    expect(child.state.done).toBe(true)

    // The parent is genuinely still settling — the child did not get in because the parent finished.
    expect(parent.state.done).toBe(false)

    Deferred.doneUnsafe(toolBlocking, Effect.void)
    await run(Fiber.join(parent.fiber))
    await run(Fiber.join(child.fiber))
  })

  test("the device shows no interactive holder once generation ends", async () => {
    const gate = make()
    const blocking = Deferred.makeUnsafe<void>()
    const parent = forkTracked(
      ProviderDispatch.runAndSettle(
        {
          events,
          scheduler: gate,
          sessionID: "parent" as never,
          slot: slotFor("parent", "interactive"),
          maxAttempts: 1,
          hasOutput: () => false,
          attempt: Effect.void,
        },
        () => Deferred.await(blocking),
      ),
    )
    await tick()
    const [device] = await run(gate.snapshot())
    // Reading the gate directly, so this fails for the right reason even if admission changes shape.
    expect(device?.inFlightInteractive ?? []).toEqual([])
    Deferred.doneUnsafe(blocking, Effect.void)
    await run(Fiber.join(parent.fiber))
  })
})

describe("release is idempotent — the in-band call and the net must not fight", () => {
  test("releasing twice frees the device exactly once and never underflows", async () => {
    const gate = make()
    await run(gate.admit(slotFor("ui", "interactive")))
    await run(gate.release(slotFor("ui", "interactive")))
    await run(gate.release(slotFor("ui", "interactive")))
    const [device] = await run(gate.snapshot())
    expect(device?.inFlightInteractive ?? []).toEqual([])
    // A second release must not free somebody ELSE's slot by decrementing a counter.
    await run(gate.admit(slotFor("other", "interactive")))
    await run(gate.release(slotFor("ui", "interactive")))
    const [after] = await run(gate.snapshot())
    expect(after?.inFlightInteractive).toEqual(["other"])
  })
})

describe("the failure and interrupt paths — where the net is the ONLY release", () => {
  test("a generation that fails still frees the device", async () => {
    // The in-band release is never reached here, which is exactly why the `ensuring` net stays.
    const gate = make()
    await run(
      ProviderDispatch.run({
        events,
        scheduler: gate,
        sessionID: "boom" as never,
        slot: slotFor("boom", "interactive"),
        maxAttempts: 1,
        hasOutput: () => false,
        attempt: Effect.fail("provider exploded" as never),
      }),
    )
    const [device] = await run(gate.snapshot())
    expect(device?.inFlightInteractive ?? []).toEqual([])
  })

  test("a turn interrupted mid-generation frees the device", async () => {
    const gate = make()
    const fiber = Effect.runFork(
      ProviderDispatch.run({
        events,
        scheduler: gate,
        sessionID: "cancelled" as never,
        slot: slotFor("cancelled", "interactive"),
        maxAttempts: 1,
        hasOutput: () => false,
        attempt: Effect.never,
      }),
    )
    await tick()
    await run(Fiber.interrupt(fiber))
    const [device] = await run(gate.snapshot())
    expect(device?.inFlightInteractive ?? []).toEqual([])
  })

  test("a QUEUED turn that is cancelled does not leak a waiter or wedge the queue", async () => {
    // 🔴 A cancelled waiter never reaches `release`. If its entry survived, the device would count a
    // phantom and later admissions would queue behind a session that no longer exists.
    const gate = make()
    await run(gate.admit(slotFor("ui", "interactive")))
    const queued = forkTracked(gate.admit(slotFor("bg", "sub-agent")))
    await tick()
    expect(queued.state.done).toBe(false)
    await run(Fiber.interrupt(queued.fiber))
    await run(gate.release(slotFor("ui", "interactive")))
    const [device] = await run(gate.snapshot())
    expect(device?.waiting ?? []).toEqual([])
    // The device still works for the next arrival.
    await run(gate.admit(slotFor("next", "sub-agent")))
    const [after] = await run(gate.snapshot())
    expect(after?.inFlightBatch).toContain("next")
  })
})

describe("lost wakeups and ordering", () => {
  test("a waiter queued BEFORE the release is woken BY it — no lost wakeup", async () => {
    const gate = make()
    await run(gate.admit(slotFor("ui", "interactive")))
    const queued = forkTracked(gate.admit(slotFor("bg", "sub-agent")))
    await tick()
    expect(queued.state.done).toBe(false)
    await run(gate.release(slotFor("ui", "interactive")))
    await tick()
    // The classic condition-variable bug: signal delivered while nobody is listening, waiter sleeps
    // forever. The drain must happen on release, not on the next arrival.
    expect(queued.state.done).toBe(true)
  })

  test("many batch turns racing one release respect the capacity cap", async () => {
    const gate = make()
    await run(gate.admit(slotFor("ui", "interactive")))
    const racers = Array.from({ length: MAX_BATCH + 4 }, (_, i) =>
      Effect.runFork(gate.admit(slotFor(`bg${i}`, "sub-agent"))),
    )
    await tick()
    await run(gate.release(slotFor("ui", "interactive")))
    await tick()
    const [device] = await run(gate.snapshot())
    // Over-admission is the hazard a race produces here: several waiters see capacity at once and
    // all take it. The count must be exactly the cap, never above it.
    expect(device!.inFlightBatch.length).toBe(MAX_BATCH)
    expect(device!.inFlightBatch.length + device!.waiting.length).toBe(MAX_BATCH + 4)
    await Promise.all(racers.map((f) => run(Fiber.interrupt(f))))
  })

  test("an interactive turn is never queued behind batch work", async () => {
    // Priority inversion in the other direction: a person waiting on saturated background work.
    const gate = make()
    for (let i = 0; i < MAX_BATCH; i++) await run(gate.admit(slotFor(`bg${i}`, "sub-agent")))
    const ui = forkTracked(gate.admit(slotFor("ui", "interactive")))
    await tick()
    expect(ui.state.done).toBe(true)
  })
})

describe("re-entrancy — the same session admitted twice", () => {
  test("a re-admitted session does not double-count itself onto the device", async () => {
    // A retry that re-enters `admit` must not leave a second phantom holder that no single release
    // can clear — the shape that would make one turn hold the device forever.
    const gate = make()
    await run(gate.admit(slotFor("ui", "interactive")))
    await run(gate.admit(slotFor("ui", "interactive")))
    await run(gate.release(slotFor("ui", "interactive")))
    const [device] = await run(gate.snapshot())
    expect(device?.inFlightInteractive ?? []).toEqual([])
    // …and a batch session can now get in, which is the consequence that actually matters.
    await run(gate.admit(slotFor("bg", "sub-agent")))
    const [after] = await run(gate.snapshot())
    expect(after?.inFlightBatch).toContain("bg")
  })
})

describe("the release sits where tools ACTUALLY run", () => {
  test("llm.ts frees the device BEFORE it settles a tool call", () => {
    // ⚠️ A source pin, deliberately. Everything else in this file drives `ProviderDispatch` with a
    // blocking `settle` — the boundary the dispatch header describes — and all of it stayed green
    // through a fix that did nothing in production. Tools are invoked from the provider stream at
    // `toolMaterialization.settle(...)`, which no unit test here can reach without a real model, a
    // real registry and a real stream.
    //
    // Measured in production either side of this line: a spawned child's first step went from
    // 599.3 s (released by its parent's 600 s join timeout) to 0.7 s.
    const source = fs.readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")
    const release = source.indexOf("scheduler.release(dispatchSlot)")
    const settle = source.indexOf("toolMaterialization.settle({")
    expect(release).toBeGreaterThan(-1)
    expect(settle).toBeGreaterThan(-1)
    // Order is the whole assertion: after the tool, it would hold the device across the call again.
    expect(release).toBeLessThan(settle)
    // …and they must be in the same branch, not merely both present somewhere in a 2600-line file.
    expect(settle - release).toBeLessThan(1500)
  })
})
