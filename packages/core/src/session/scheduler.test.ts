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
      gate
        .admit({ sessionID: "hot", deviceKey: "d", sessionClass: "auto-prompting" })
        .pipe(Effect.map(() => order.push("hot"))),
    )
    const coldFiber = Effect.runFork(
      gate
        .admit({ sessionID: "cold", deviceKey: "d", sessionClass: "auto-prompting" })
        .pipe(Effect.map(() => order.push("cold"))),
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

// ── ledger retention (U7 Part A) ──────────────────────────────────────────────────────────────
//
// `admit` inserts on EVERY turn and `evict` only fires on session REMOVAL, so a session that ran
// once and then sat idle kept its ledger entry for the life of the instance. The cost is not the
// ~100 bytes — it is `charge()`: `totalWeight()` sums every entry, so each dead session slows
// virtual-time advance for every live one on that device, forever.
//
// The fix is retention on the ledger's OWN forgiveness TTL, not eviction on idle. Evicting on idle
// would launder over-consumption through brief sleeps — precisely what eevdf.ts's header forbids.
// Past the TTL there is no debt left to launder: `onWake` zeroes the lag anyway, so dropping the
// entry and re-`ensure`ing it land in exactly the same place. The two tests below are the pair
// that makes that claim mechanical.
describe("ledger retention: bounded by the forgiveness TTL, not by session lifetime", () => {
  /** A gate on a fake clock with a 1s forgiveness/retention window. */
  const fake = () => {
    let clock = 0
    const gate = make({ now: () => clock, forgivenessMs: 1_000 })
    return { gate, advance: (ms: number) => (clock += ms), at: () => clock }
  }
  const ledgerHas = (devices: readonly { ledger: readonly { id: string }[] }[], id: string) =>
    devices.some((device) => device.ledger.some((entry) => entry.id === id))

  test("an idle session's entry is dropped once its block outlives the TTL", async () => {
    const { gate, advance } = fake()
    await run(gate.admit({ sessionID: "gone", deviceKey: "d", sessionClass: "interactive" }))
    await run(gate.release({ sessionID: "gone", deviceKey: "d" }))
    expect(ledgerHas(await run(gate.snapshot()), "gone")).toBe(true) // still inside the window

    advance(5_000)
    // any other traffic on the device sweeps — here the next session's admit
    await run(gate.admit({ sessionID: "live", deviceKey: "d", sessionClass: "interactive" }))

    const [device] = await run(gate.snapshot())
    expect(device!.ledger.map((entry) => entry.id)).toEqual(["live"])
  })

  test("NEGATIVE CONTROL: inside the TTL the entry AND its debt survive — no laundering by sleeping", async () => {
    const { gate, advance } = fake()
    await run(gate.admit({ sessionID: "hog", deviceKey: "d", sessionClass: "interactive" }))
    await run(gate.admit({ sessionID: "peer", deviceKey: "d", sessionClass: "interactive" }))
    await run(gate.report({ sessionID: "hog", deviceKey: "d", costTokens: 500_000 }))
    await run(gate.release({ sessionID: "hog", deviceKey: "d" }))
    const indebted = (await run(gate.snapshot()))[0]!.ledger.find((entry) => entry.id === "hog")!.lag
    expect(indebted).toBeLessThan(0)

    advance(500) // a brief sleep — well inside the forgiveness window
    await run(gate.admit({ sessionID: "hog", deviceKey: "d", sessionClass: "interactive" }))

    const entry = (await run(gate.snapshot()))[0]!.ledger.find((e) => e.id === "hog")
    expect(entry).toBeDefined()
    expect(entry!.lag).toBe(indebted) // the debt came back with it
  })

  test("past the TTL the returning session lands at lag 0 — which is why dropping it is lossless", async () => {
    const { gate, advance } = fake()
    // The equivalence the whole design rests on: whether the sweep gets there first (entry
    // dropped, then re-`ensure`d at the current virtual time) or `onWake` does (lag reset to 0),
    // the session lands in the SAME place. So the sweep destroys no debt the policy was keeping.
    const lagOf = async (id: string) => (await run(gate.snapshot()))[0]!.ledger.find((entry) => entry.id === id)?.lag
    // A peer is REQUIRED to owe anything at all: with one entry, `charge` advances virtual time
    // and vruntime by the same amount, so a solo session sits exactly on its share (lag 0).
    await run(gate.admit({ sessionID: "peer", deviceKey: "d", sessionClass: "interactive" }))
    await run(gate.admit({ sessionID: "hog", deviceKey: "d", sessionClass: "interactive" }))
    await run(gate.report({ sessionID: "hog", deviceKey: "d", costTokens: 500_000 }))
    await run(gate.release({ sessionID: "hog", deviceKey: "d" }))
    expect(await lagOf("hog")).toBeLessThan(0)

    advance(5_000)
    await run(gate.admit({ sessionID: "hog", deviceKey: "d", sessionClass: "interactive" }))

    expect(await lagOf("hog")).toBe(0)
  })

  test("a turn in flight is never swept, however long it runs", async () => {
    const { gate, advance } = fake()
    await run(gate.admit({ sessionID: "long", deviceKey: "d", sessionClass: "interactive" }))
    advance(60_000)
    await run(gate.admit({ sessionID: "other", deviceKey: "d", sessionClass: "interactive" }))
    const [device] = await run(gate.snapshot())
    expect(ledgerHas([device!], "long")).toBe(true)
    expect(device!.inFlightInteractive).toContain("long")
  })

  test("a QUEUED waiter is never swept — losing its entry would strand it forever", async () => {
    const { gate, advance } = fake()
    await run(gate.admit({ sessionID: "b1", deviceKey: "d", sessionClass: "auto-prompting" }))
    await run(gate.admit({ sessionID: "b2", deviceKey: "d", sessionClass: "auto-prompting" }))
    let admitted = false
    const fiber = Effect.runFork(
      gate.admit({ sessionID: "queued", deviceKey: "d", sessionClass: "auto-prompting" }).pipe(
        Effect.map(() => {
          admitted = true
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    advance(60_000) // the queue outlives the TTL many times over
    await run(gate.release({ sessionID: "b1", deviceKey: "d" })) // …and this sweeps
    await run(Fiber.await(fiber))
    // `drain` picks THROUGH the ledger (`pick` skips ids it has no entry for), so a swept waiter
    // would never be chosen and this admit would hang forever. Today the waiter is safe by
    // construction — `admit` clears the block stamp — and the sweep's `retain` pin is the belt to
    // that braces: it makes "the gate never loses an entry it is still tracking" structural
    // rather than a property of the current stamping order.
    expect(admitted).toBe(true)
  })

  test("a CANCELLED waiter's entry is swept (it never reaches release)", async () => {
    const { gate, advance } = fake()
    await run(gate.admit({ sessionID: "ui", deviceKey: "d", sessionClass: "interactive" }))
    const fiber = Effect.runFork(gate.admit({ sessionID: "bg", deviceKey: "d", sessionClass: "cron" }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await run(Fiber.interrupt(fiber))
    expect(ledgerHas(await run(gate.snapshot()), "bg")).toBe(true) // still inside the window

    advance(5_000)
    await run(gate.release({ sessionID: "ui", deviceKey: "d" }))

    expect(ledgerHas(await run(gate.snapshot()), "bg")).toBe(false)
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
// ⚠️ `Effect.ensuring` is the CHOSEN remedy, not a stopgap for a still-open gap. Wrapping the sleep
// in `Effect.exit` — the symmetric-looking fix — is worse: the interrupt becomes a value, so a Stop
// stops LEAVING at the sleep and instead falls through the whole post-generation tail (a redundant
// provider attempt, the failure publishes, a `patchSessionRecord` write) to reach the same interrupt
// exit. It does not deadlock — the tail's own restore/exit boundaries re-raise the pending interrupt
// immediately — but it puts work and event traffic on the one path that must stay prompt, and it
// drives an interrupted fiber through `recoverOverflow`'s non-exit-wrapped restore. The net fixes
// the leak with ZERO change to interrupt timing; the sleep stays bare on purpose.
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

  test("runner/llm.ts guards the dispatch slot with Effect.ensuring — and leaves the sleep bare", () => {
    // A source assertion, deliberately: removing the net compiles green, and nothing in the fast
    // suite executes `llm.ts` (session-runner.test.ts is win32-skipped and wedges from source), so
    // the behavioural tests above would keep passing against their local copy of the shape.
    const source = fs.readFileSync(path.join(import.meta.dir, "runner", "llm.ts"), "utf8")
    expect(source).toContain("Effect.ensuring(scheduler.release(dispatchSlot))")
    // The other half of the decision: the retry sleep must stay un-exit-wrapped, so a Stop still
    // exits AT the sleep instead of falling through the post-generation tail. `Effect.exit` on it
    // would look like a tightening and would silently lengthen the Stop path.
    const sleepAt = source.indexOf("ProviderRetry.retryDelayMs")
    expect(sleepAt).toBeGreaterThan(0)
    expect(source.slice(sleepAt, sleepAt + 160)).not.toContain("Effect.exit")
  })
})
