import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { SessionWorkerAdmission } from "./admission"

const run = Effect.runPromise
const batch = (sessionID: string) => ({ sessionID, priority: "batch" as const })
const interactive = (sessionID: string) => ({ sessionID, priority: "interactive" as const })
const governing = (sessionID: string) => ({ sessionID, priority: "governing" as const })

describe("session-worker admission", () => {
  test("derives process capacity from the canonical fleet byte ceiling", () => {
    expect(
      SessionWorkerAdmission.capacity(
        5 * SessionWorkerAdmission.SOURCE_RESERVATION_BYTES,
        SessionWorkerAdmission.SOURCE_RESERVATION_BYTES,
      ),
    ).toBe(5)
    expect(
      SessionWorkerAdmission.capacity(
        SessionWorkerAdmission.SOURCE_RESERVATION_BYTES,
        SessionWorkerAdmission.SOURCE_RESERVATION_BYTES,
      ),
    ).toBe(2)
    expect(
      SessionWorkerAdmission.capacity(
        8 * SessionWorkerAdmission.PACKAGED_RESERVATION_BYTES,
        SessionWorkerAdmission.PACKAGED_RESERVATION_BYTES,
      ),
    ).toBe(8)
    expect(SessionWorkerAdmission.reservationBytes("session-worker.ts")).toBe(
      SessionWorkerAdmission.SOURCE_RESERVATION_BYTES,
    )
    expect(SessionWorkerAdmission.reservationBytes("novaclaw-session-worker.js")).toBe(
      SessionWorkerAdmission.PACKAGED_RESERVATION_BYTES,
    )
  })

  test("background work cannot consume the opened-chat and Nova lanes", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 8 }))
    const release = Deferred.makeUnsafe<void>()
    const backgroundEntered = Deferred.makeUnsafe<void>()
    const controlsEntered = Deferred.makeUnsafe<void>()
    let backgrounds = 0
    let controls = 0
    const hold = (input: ReturnType<typeof batch> | ReturnType<typeof interactive> | ReturnType<typeof governing>) =>
      gate.run(
        input,
        Effect.gen(function* () {
          if (input.priority === "batch" && ++backgrounds === 6) Deferred.doneUnsafe(backgroundEntered, Effect.void)
          if (input.priority !== "batch" && ++controls === 2) Deferred.doneUnsafe(controlsEntered, Effect.void)
          yield* Deferred.await(release)
        }),
      )

    const fibers = Array.from({ length: 6 }, (_, index) => Effect.runFork(hold(batch(`batch-${index}`))))
    await run(Deferred.await(backgroundEntered))
    const queued = Effect.runFork(hold(batch("queued")))
    expect(gate.snapshot().waitingBatch).toEqual(["queued"])

    const opened = Effect.runFork(hold(interactive("opened")))
    const nova = Effect.runFork(hold(governing("nova")))
    await run(Deferred.await(controlsEntered))
    expect(gate.snapshot().active).toHaveLength(8)
    expect(gate.snapshot().active).toContain("opened")
    expect(gate.snapshot().active).toContain("nova")
    expect(gate.snapshot().waitingBatch).toEqual(["queued"])

    await run(Deferred.succeed(release, undefined))
    await Promise.all([...fibers, queued, opened, nova].map((fiber) => run(Fiber.join(fiber))))
  })

  test("opening an active background session immediately frees its batch share", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 4 }))
    const release = Deferred.makeUnsafe<void>()
    const twoEntered = Deferred.makeUnsafe<void>()
    const thirdEntered = Deferred.makeUnsafe<void>()
    let entered = 0
    const worker = (id: string) =>
      gate.run(
        batch(id),
        Effect.gen(function* () {
          entered++
          if (entered === 2) Deferred.doneUnsafe(twoEntered, Effect.void)
          if (id === "third") Deferred.doneUnsafe(thirdEntered, Effect.void)
          yield* Deferred.await(release)
        }),
      )
    const first = Effect.runFork(worker("first"))
    const second = Effect.runFork(worker("second"))
    await run(Deferred.await(twoEntered))
    const third = Effect.runFork(worker("third"))
    expect(gate.snapshot().waitingBatch).toEqual(["third"])

    gate.reprioritize("first", "interactive")
    await run(Deferred.await(thirdEntered))
    expect(gate.snapshot().active).toHaveLength(3)
    expect(gate.snapshot().waitingBatch).toEqual([])

    await run(Deferred.succeed(release, undefined))
    await Promise.all([first, second, third].map((fiber) => run(Fiber.join(fiber))))
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

  test("opening a queued chat promotes it ahead of older background work", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 1 }))
    const release = Deferred.makeUnsafe<void>()
    const entered = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const holder = Effect.runFork(
      gate.run(
        batch("holder"),
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      ),
    )
    await run(Deferred.await(entered))
    const older = Effect.runFork(
      gate.run(
        batch("older"),
        Effect.sync(() => order.push("older")),
      ),
    )
    const opened = Effect.runFork(
      gate.run(
        batch("opened"),
        Effect.sync(() => order.push("opened")),
      ),
    )
    gate.reprioritize("opened", "interactive")

    expect(gate.snapshot().waitingInteractive).toEqual(["opened"])
    await run(Deferred.succeed(release, undefined))
    await run(Fiber.join(holder))
    await Promise.all([run(Fiber.join(older)), run(Fiber.join(opened))])
    expect(order).toEqual(["opened", "older"])
  })

  test("Nova jumps ahead of an opened chat and background work", async () => {
    const gate = await run(SessionWorkerAdmission.make({ capacity: 1 }))
    const release = Deferred.makeUnsafe<void>()
    const entered = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const holder = Effect.runFork(
      gate.run(
        batch("holder"),
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      ),
    )
    await run(Deferred.await(entered))
    const background = Effect.runFork(
      gate.run(
        batch("background"),
        Effect.sync(() => order.push("background")),
      ),
    )
    const opened = Effect.runFork(
      gate.run(
        interactive("opened"),
        Effect.sync(() => order.push("opened")),
      ),
    )
    const nova = Effect.runFork(
      gate.run(
        governing("nova"),
        Effect.sync(() => order.push("nova")),
      ),
    )

    expect(gate.snapshot().waitingGoverning).toEqual(["nova"])
    await run(Deferred.succeed(release, undefined))
    await run(Fiber.join(holder))
    await Promise.all([run(Fiber.join(background)), run(Fiber.join(opened)), run(Fiber.join(nova))])
    expect(order).toEqual(["nova", "opened", "background"])
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
