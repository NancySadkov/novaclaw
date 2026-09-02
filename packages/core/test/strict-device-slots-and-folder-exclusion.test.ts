import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { ProviderDispatch } from "@novaclaw/core/session/runner/provider-dispatch"
import { attemptSlot, folderExclusion } from "@novaclaw/core/session/runner/strict-drain"
import { make as makeScheduler } from "@novaclaw/core/session/scheduler"

/**
 * Two claims about what a Strict run occupies while it is running: a slot on the device, and the
 * folder it edits.
 *
 * ⚠️ Everything about concurrency here runs REAL fibers against the REAL admission gate. A final
 * tally is not evidence: both the correct and the broken accounting end with an idle device, and
 * the difference is only visible WHILE the generations are in flight. So every assertion below is
 * taken with the racers deliberately held open, and each fix arm is paired with a control arm that
 * reproduces the defect it closes.
 */

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
/** Let queued fibers make progress without pinning the test to a wall clock. */
const tick = () => run(Effect.yieldNow.pipe(Effect.andThen(Effect.sleep("20 millis"))))

const forkTracked = <A>(effect: Effect.Effect<A>) => {
  const state = { done: false }
  const fiber = Effect.runFork(effect.pipe(Effect.map((a) => ((state.done = true), a))))
  return { fiber, state }
}

const events = { publish: () => Effect.void } as never

/** The slot a Strict drain builds for its session, with the device's declared background cap. */
const baseSlot = (sessionID: string, sessionClass: string, concurrency?: number) =>
  ({
    sessionID,
    deviceKey: "spark",
    sessionClass,
    ...(concurrency === undefined ? {} : { concurrency }),
  }) as never

/** One racer: a generation that stays on the wire until its own latch is opened. */
const racer = (scheduler: unknown, slot: unknown, held: Deferred.Deferred<void>) =>
  forkTracked(
    ProviderDispatch.run({
      events,
      scheduler: scheduler as never,
      sessionID: "ses_race" as never,
      slot: slot as never,
      maxAttempts: 1,
      hasOutput: () => false,
      attempt: Deferred.await(held),
    }),
  )

describe("best-of-N racing — N generations must count as N on the device", () => {
  test("racers hold N interactive slots, and the device is free only when the LAST one settles", async () => {
    // The measured harm: the first racer to finish released the session's one slot and a waiting
    // batch turn was admitted while the other generations were still generating. So the assertion
    // is about the moment BETWEEN the first settlement and the last, which a final count cannot see.
    const scheduler = makeScheduler()
    const base = baseSlot("ses_race", "interactive")
    const latches = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
    const racers = latches.map((held, i) => racer(scheduler, attemptSlot(base, i + 1), held))
    await tick()

    const [busy] = await run(scheduler.snapshot())
    expect(busy?.inFlightInteractive?.length, "three racing generations are three participants").toBe(3)

    const child = forkTracked(scheduler.admit(baseSlot("ses_child", "sub-agent")))
    await tick()
    expect(child.state.done, "batch work waits while any interactive generation is on the wire").toBe(false)

    // ⭐ THE ASSERTION. One racer settles; two are still generating.
    Deferred.doneUnsafe(latches[0]!, Effect.void)
    await run(Fiber.join(racers[0]!.fiber))
    await tick()
    expect(child.state.done, "the first racer to finish does not release the device for the rest").toBe(false)
    const [partial] = await run(scheduler.snapshot())
    expect(partial?.inFlightInteractive?.length, "the two unfinished racers still hold their own slots").toBe(2)

    for (const held of latches.slice(1)) Deferred.doneUnsafe(held, Effect.void)
    for (const r of racers.slice(1)) await run(Fiber.join(r.fiber))
    await tick()
    expect(child.state.done, "the device is free once the last generation settles").toBe(true)
    await run(Fiber.join(child.fiber))
  })

  test("CONTROL — the same three racers sharing ONE slot identity reproduce the bypass", async () => {
    // Not a second implementation of the fix: this is the shipped code path with `attemptSlot`
    // removed, and it is here so the claim above cannot pass for a reason that has nothing to do
    // with slot identity.
    const scheduler = makeScheduler()
    const shared = baseSlot("ses_race", "interactive")
    const latches = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
    const racers = latches.map((held) => racer(scheduler, shared, held))
    await tick()

    const [busy] = await run(scheduler.snapshot())
    expect(busy?.inFlightInteractive?.length, "admission is idempotent per id: three count as one").toBe(1)

    const child = forkTracked(scheduler.admit(baseSlot("ses_child", "sub-agent")))
    await tick()
    Deferred.doneUnsafe(latches[0]!, Effect.void)
    await run(Fiber.join(racers[0]!.fiber))
    await tick()
    expect(child.state.done, "one settlement frees the slot all three were riding").toBe(true)

    for (const held of latches.slice(1)) Deferred.doneUnsafe(held, Effect.void)
    for (const r of racers.slice(1)) await run(Fiber.join(r.fiber))
    await run(Fiber.join(child.fiber))
  })

  test("a BATCH-class race queues its racers past the device's declared ceiling", async () => {
    // The cap the scheduler advertises is `device.concurrency`. With one identity it was enforced
    // against one generation; with N it is enforced against N — which is the whole point of the
    // number. Nothing here serializes the race by policy: two run at once because the device said
    // two.
    const scheduler = makeScheduler()
    const base = baseSlot("ses_race", "sub-agent", 2)
    const latches = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
    const racers = latches.map((held, i) => racer(scheduler, attemptSlot(base, i + 1), held))
    await tick()

    const [device] = await run(scheduler.snapshot())
    expect(device?.inFlightBatch?.length, "two racers admitted — the device's own ceiling").toBe(2)
    expect(device?.waiting?.length, "the third waits instead of running uncounted").toBe(1)

    for (const held of latches) Deferred.doneUnsafe(held, Effect.void)
    for (const r of racers) await run(Fiber.join(r.fiber))
  })
})

describe("two engines must never work the same folder", () => {
  test("a second run on the SAME folder is refused, and a run on ANOTHER folder is not", async () => {
    const project = folderExclusion()
    const elsewhere = folderExclusion()
    const holding = Deferred.makeUnsafe<void>()
    const ran: string[] = []

    const first = await run(
      project.enter(Effect.sync(() => { ran.push("first") }).pipe(Effect.andThen(Deferred.await(holding)))),
    )
    await tick()
    expect(first, "the first run claims the folder").not.toBeUndefined()

    // ⭐ A DIFFERENT SESSION, same folder, while the first engine is still writing.
    const second = await run(project.enter(Effect.sync(() => { ran.push("second") })))
    expect(second, "the folder is claimed, so the second engine never starts").toBeUndefined()
    await tick()
    expect(ran, "and its body did not run — refusing is not deferring").toEqual(["first"])

    // ⭐ THE CONTROL that stops this being a global lock: another location is another folder.
    const other = await run(elsewhere.enter(Effect.sync(() => { ran.push("other") })))
    expect(other, "a run in a different folder is unaffected").not.toBeUndefined()
    await run(Fiber.join(other!))
    expect(ran).toEqual(["first", "other"])

    // The holder is the engine's own fiber, so the folder frees when THAT settles, not before.
    expect(project.busy(), "still held while the first engine runs").toBe(true)
    Deferred.doneUnsafe(holding, Effect.void)
    await run(Fiber.join(first!))
    await tick()
    expect(project.busy(), "released by the fiber that owned it").toBe(false)
    const third = await run(project.enter(Effect.sync(() => { ran.push("third") })))
    expect(third, "the next run gets the folder").not.toBeUndefined()
    await run(Fiber.join(third!))
    expect(ran).toEqual(["first", "other", "third"])
  })

  test("a run that DIES releases the folder — the claim is freed on every exit, not on success", async () => {
    // The failure mode a claim like this has: a folder held for the life of the process because the
    // release was written on the happy path. The engine's fiber is detached precisely so a Stop
    // cannot kill it, so the only exits are completion and a defect — and a defect is the one a
    // release-on-success would miss.
    const project = folderExclusion()
    const held = await run(project.enter(Effect.die(new Error("engine defect"))))
    expect(held, "the run claimed the folder").not.toBeUndefined()
    await run(Fiber.await(held!))
    await tick()
    expect(project.busy(), "released by the fiber's finalizer, on every exit").toBe(false)
    const next = await run(project.enter(Effect.void))
    expect(next, "and the next run can have it").not.toBeUndefined()
    await run(Fiber.await(next!))
  })
})
