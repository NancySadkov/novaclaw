import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { SessionWorkerAdmission } from "./admission"

const run = Effect.runPromise
const batch = (sessionID: string) => ({ sessionID, priority: "batch" as const })
const interactive = (sessionID: string) => ({ sessionID, priority: "interactive" as const })

describe("session-worker admission", () => {
  test("derives process capacity from the canonical fleet byte ceiling", () => {
    expect(SessionWorkerAdmission.capacity(5 * SessionWorkerAdmission.RESERVATION_BYTES)).toBe(5)
    expect(SessionWorkerAdmission.capacity(SessionWorkerAdmission.RESERVATION_BYTES)).toBe(2)
  })

  test("never admits more resident workers than reserved capacity", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 2 }))
    const release = Deferred.makeUnsafe<void>()
    const admitted = Deferred.makeUnsafe<void>()
    let active = 0
    let peak = 0
    const worker = (id: string) =>
      gate.run(
        batch(id),
        Effect.gen(function* () {
          active++
          peak = Math.max(peak, active)
          if (active === 2) Deferred.doneUnsafe(admitted, Effect.void)
          yield* Deferred.await(release)
          active--
        }),
      )
    const fibers = [Effect.runFork(worker("one")), Effect.runFork(worker("two")), Effect.runFork(worker("three"))]

    await run(Deferred.await(admitted))
    expect(active).toBe(2)
    expect(peak).toBe(2)
    expect(gate.snapshot().waitingBatch).toEqual(["three"])

    await run(Deferred.succeed(release, undefined))
    await Promise.all(fibers.map((fiber) => run(Fiber.join(fiber))))
    expect(active).toBe(0)
  })

  test("an interactive turn jumps ahead of queued batch work", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 1 }))
    const holderRelease = Deferred.makeUnsafe<void>()
    const holderEntered = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const holder = Effect.runFork(
      gate.run(
        batch("holder"),
        Effect.gen(function* () {
          yield* Deferred.succeed(holderEntered, undefined)
          yield* Deferred.await(holderRelease)
        }),
      ),
    )
    await run(Deferred.await(holderEntered))
    const queuedBatch = Effect.runFork(
      gate.run(
        batch("batch"),
        Effect.sync(() => order.push("batch")),
      ),
    )
    const queuedInteractive = Effect.runFork(
      gate.run(
        interactive("interactive"),
        Effect.sync(() => order.push("interactive")),
      ),
    )
    expect(gate.snapshot().waitingInteractive).toEqual(["interactive"])
    expect(gate.snapshot().waitingBatch).toEqual(["batch"])

    await run(Deferred.succeed(holderRelease, undefined))
    await run(Fiber.join(holder))
    await Promise.all([run(Fiber.join(queuedBatch)), run(Fiber.join(queuedInteractive))])
    expect(order).toEqual(["interactive", "batch"])
  })

  test("an interrupted waiter leaks no permit", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 2 }))
    const holdersRelease = Deferred.makeUnsafe<void>()
    const admitted = Deferred.makeUnsafe<void>()
    let active = 0
    const holder = (id: string) =>
      gate.run(
        batch(id),
        Effect.gen(function* () {
          active++
          if (active === 2) Deferred.doneUnsafe(admitted, Effect.void)
          yield* Deferred.await(holdersRelease)
        }),
      )
    const holders = [Effect.runFork(holder("one")), Effect.runFork(holder("two"))]
    await run(Deferred.await(admitted))
    const queued = Effect.runFork(gate.run(batch("cancelled"), Effect.void))
    expect(gate.snapshot().waitingBatch).toEqual(["cancelled"])

    await run(Fiber.interrupt(queued))
    expect(gate.snapshot().waitingBatch).toEqual([])
    await run(Deferred.succeed(holdersRelease, undefined))
    await Promise.all(holders.map((fiber) => run(Fiber.join(fiber))))

    await run(gate.run(batch("next"), Effect.void))
    expect(gate.snapshot().active).toEqual([])
  })

  test("failure releases capacity for the next queued worker", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 1 }))
    const failed = await run(gate.run(batch("failed"), Effect.fail("boom")).pipe(Effect.exit))
    expect(failed._tag).toBe("Failure")
    await run(gate.run(batch("next"), Effect.void))
    expect(gate.snapshot().active).toEqual([])
  })
})
