import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { MAX_BATCH, make } from "./scheduler"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

afterEach(() => {
  delete process.env.NOVACLAW_DISABLE_SCHEDULER
})

describe("session scheduler admission gate", () => {
  test("interactive admits immediately, even with batch saturated", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "b1", deviceKey: "d", sessionClass: "auto-prompting" }))
    await run(gate.admit({ sessionID: "b2", deviceKey: "d", sessionClass: "auto-prompting" }))
    // batch full (MAX_BATCH) — interactive still goes straight through
    await run(gate.admit({ sessionID: "ui", deviceKey: "d", sessionClass: "interactive" }))
    const [device] = await run(gate.snapshot())
    expect(device!.inFlightInteractive).toEqual(["ui"])
    expect(device!.inFlightBatch.length).toBe(MAX_BATCH)
  })

  test("batch waits while an interactive turn is generating; drains on release", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "ui", deviceKey: "d", sessionClass: "interactive" }))
    let admitted = false
    const fiber = Effect.runFork(
      gate.admit({ sessionID: "bg", deviceKey: "d", sessionClass: "sub-agent" }).pipe(
        Effect.map(() => {
          admitted = true
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(admitted).toBe(false)
    await run(gate.release({ sessionID: "ui", deviceKey: "d" }))
    await run(Fiber.await(fiber))
    expect(admitted).toBe(true)
  })

  test("MAX_BATCH cap: the third batch session waits for a slot", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "b1", deviceKey: "d", sessionClass: "auto-prompting" }))
    await run(gate.admit({ sessionID: "b2", deviceKey: "d", sessionClass: "auto-prompting" }))
    let admitted = false
    const fiber = Effect.runFork(
      gate.admit({ sessionID: "b3", deviceKey: "d", sessionClass: "auto-prompting" }).pipe(
        Effect.map(() => {
          admitted = true
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(admitted).toBe(false)
    await run(gate.release({ sessionID: "b1", deviceKey: "d" }))
    await run(Fiber.await(fiber))
    expect(admitted).toBe(true)
  })

  test("drain picks fairly: the indebted session yields the first freed slot", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "b1", deviceKey: "d", sessionClass: "auto-prompting" }))
    await run(gate.admit({ sessionID: "b2", deviceKey: "d", sessionClass: "auto-prompting" }))
    const order: string[] = []
    // Queue BOTH waiters first (registration order favors hot), THEN charge hot's
    // debt — with peers registered, virtual time advances slower than hot's vruntime.
    const hotFiber = Effect.runFork(
      gate.admit({ sessionID: "hot", deviceKey: "d", sessionClass: "auto-prompting" }).pipe(
        Effect.map(() => order.push("hot")),
      ),
    )
    const coldFiber = Effect.runFork(
      gate.admit({ sessionID: "cold", deviceKey: "d", sessionClass: "auto-prompting" }).pipe(
        Effect.map(() => order.push("cold")),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await run(gate.report({ sessionID: "hot", deviceKey: "d", costTokens: 300_000 }))
    await run(gate.release({ sessionID: "b1", deviceKey: "d" }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await run(gate.release({ sessionID: "b2", deviceKey: "d" }))
    await run(Fiber.await(hotFiber))
    await run(Fiber.await(coldFiber))
    // hot is deep in EEVDF debt (ineligible) — cold takes the first freed slot.
    expect(order[0]).toBe("cold")
    expect(order[1]).toBe("hot")
  })

  test("interrupting a waiting admit removes the waiter", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "ui", deviceKey: "d", sessionClass: "interactive" }))
    const fiber = Effect.runFork(gate.admit({ sessionID: "bg", deviceKey: "d", sessionClass: "cron" }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await run(Fiber.interrupt(fiber))
    const [device] = await run(gate.snapshot())
    expect(device!.waiting).toEqual([])
  })

  test("evict wakes a waiting session and drops its ledger entry", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "ui", deviceKey: "d", sessionClass: "interactive" }))
    const fiber = Effect.runFork(gate.admit({ sessionID: "bg", deviceKey: "d", sessionClass: "cron" }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await run(gate.evict("bg"))
    await run(Fiber.await(fiber))
    const [device] = await run(gate.snapshot())
    expect(device!.waiting).toEqual([])
    expect(device!.ledger.some((entry) => entry.id === "bg")).toBe(false)
  })

  test("kill switch: NOVACLAW_DISABLE_SCHEDULER admits everything immediately", async () => {
    process.env.NOVACLAW_DISABLE_SCHEDULER = "1"
    const gate = make()
    for (let i = 0; i < 10; i++)
      await run(gate.admit({ sessionID: `b${i}`, deviceKey: "d", sessionClass: "auto-prompting" }))
    const devices = await run(gate.snapshot())
    expect(devices.length).toBe(0) // no bookkeeping at all when disabled
  })

  test("priority overrides the class weight (K1 priority finally consumed)", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "vip", deviceKey: "d", sessionClass: "cron", priority: 500 }))
    const [device] = await run(gate.snapshot())
    expect(device!.ledger.find((entry) => entry.id === "vip")?.weight).toBe(500)
  })

  test("devices are independent", async () => {
    const gate = make()
    await run(gate.admit({ sessionID: "ui", deviceKey: "spark", sessionClass: "interactive" }))
    // A batch turn on ANOTHER device is not blocked by spark's interactive turn.
    await run(gate.admit({ sessionID: "bg", deviceKey: "other", sessionClass: "auto-prompting" }))
    const devices = await run(gate.snapshot())
    expect(devices.length).toBe(2)
  })
})
