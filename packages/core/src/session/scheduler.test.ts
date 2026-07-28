import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Duration, Effect, Fiber } from "effect"
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

// ── the dispatch-slot leak (runner/llm.ts) ────────────────────────────────────────────────────
//
// `runTurnAttempt` admits, then runs the provider stream inside an `uninterruptibleMask` with a
// backoff sleep between retries. The two stream runs are wrapped in `Effect.exit`, so an interrupt
// there still reaches the in-band `release`; the SLEEP is not, so a Stop landing in the backoff
// window propagates straight out of the generator and skips it. Idempotency of `release` is no
// defence — it is never CALLED. The consequence is not a slow leak but a DEAD DEVICE: `batchCapacity`
// requires `inFlightInteractive.size === 0`, so one leaked interactive entry blocks every batch
// session on that deviceKey forever.
//
// This models that exact composition against the real gate. It cannot execute `llm.ts` (the fast
// suite never does), so the source assertion below pins the invariant in the file itself.
describe("dispatch-slot release on interrupt (runner/llm.ts composition)", () => {
  const turn = (gate: ReturnType<typeof make>, slot: { sessionID: string; deviceKey: string }, guarded: boolean) => {
    const generation = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // the retry backoff: the one interruptible await with no `Effect.exit` around it
        yield* restore(Effect.sleep(Duration.seconds(30)))
        yield* gate.release(slot)
      }),
    )
    const admitted = gate.admit({ ...slot, sessionClass: "interactive" as const }).pipe(Effect.andThen(generation))
    return guarded ? admitted.pipe(Effect.ensuring(gate.release(slot))) : admitted
  }

  test("an interrupt during the retry sleep still frees the slot", async () => {
    const gate = make()
    const slot = { sessionID: "ui", deviceKey: "d" }
    const fiber = Effect.runFork(turn(gate, slot, true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await run(gate.snapshot()))[0]!.inFlightInteractive).toEqual(["ui"])

    await run(Fiber.interrupt(fiber))

    const [device] = await run(gate.snapshot())
    expect(device!.inFlightInteractive).toEqual([])
    // and the device is usable again: a batch turn admits immediately
    await run(gate.admit({ sessionID: "bg", deviceKey: "d", sessionClass: "auto-prompting" }))
    expect((await run(gate.snapshot()))[0]!.inFlightBatch).toEqual(["bg"])
  })

  test("NEGATIVE CONTROL: without the ensuring the same interrupt leaks the slot and zeroes batch capacity", async () => {
    const gate = make()
    const slot = { sessionID: "ui", deviceKey: "d" }
    const fiber = Effect.runFork(turn(gate, slot, false))
    await new Promise((resolve) => setTimeout(resolve, 20))

    await run(Fiber.interrupt(fiber))

    const [device] = await run(gate.snapshot())
    expect(device!.inFlightInteractive).toEqual(["ui"]) // leaked — release was never called
    // …and every batch session on that device is now blocked forever
    let admitted = false
    const blocked = Effect.runFork(
      gate.admit({ sessionID: "bg", deviceKey: "d", sessionClass: "auto-prompting" }).pipe(
        Effect.map(() => {
          admitted = true
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(admitted).toBe(false)
    await run(Fiber.interrupt(blocked))
  })

  test("runner/llm.ts guards the dispatch slot with Effect.ensuring", () => {
    // A source assertion, deliberately: removing the net compiles green, and nothing in the fast
    // suite executes `llm.ts` (session-runner.test.ts is win32-skipped and wedges from source), so
    // the behavioural tests above would keep passing against their local copy of the shape.
    const source = fs.readFileSync(path.join(import.meta.dir, "runner", "llm.ts"), "utf8")
    expect(source).toContain("Effect.ensuring(scheduler.release(dispatchSlot))")
  })
})
