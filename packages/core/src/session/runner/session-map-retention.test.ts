import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { make } from "./session-map-retention"

const fixture = () => {
  let clock = 0
  const stores = Array.from({ length: 6 }, () => new Map<string, unknown>())
  const retention = make(stores, { now: () => clock, forgivenessMs: 1_000 })
  const run = <A, E>(sessionID: string, effect: Effect.Effect<A, E>) =>
    Effect.runPromise(retention.withSession(sessionID, effect))
  const seed = (sessionID: string) => {
    for (const store of stores) store.set(sessionID, { retained: true })
  }
  return {
    stores,
    run,
    seed,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("runner session-map retention", () => {
  test("keeps all six controller maps through a brief idle", async () => {
    const { stores, run, seed, advance } = fixture()
    await run(
      "brief",
      Effect.sync(() => seed("brief")),
    )
    advance(1_000)
    await run("trigger", Effect.void)
    expect(stores.map((store) => store.has("brief"))).toEqual([true, true, true, true, true, true])
  })

  test("sweeps all six maps after the forgiveness window", async () => {
    const { stores, run, seed, advance } = fixture()
    await run(
      "stale",
      Effect.sync(() => seed("stale")),
    )
    advance(1_001)
    await run("trigger", Effect.void)
    expect(stores.map((store) => store.has("stale"))).toEqual([false, false, false, false, false, false])
  })

  test("a resumed stale session starts fresh in the safe over-steering direction", async () => {
    const { stores, run, seed, advance } = fixture()
    await run(
      "returning",
      Effect.sync(() => seed("returning")),
    )
    advance(1_001)
    await run(
      "returning",
      Effect.sync(() => {
        expect(stores.every((store) => !store.has("returning"))).toBe(true)
      }),
    )
  })

  test("an active drain stays pinned while another session triggers a sweep", async () => {
    const { stores, run, seed, advance } = fixture()
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const active = run(
      "active",
      Effect.promise(async () => {
        seed("active")
        started()
        await held
      }),
    )
    await entered
    advance(5_000)
    await run("trigger", Effect.void)
    expect(stores.every((store) => store.has("active"))).toBe(true)
    release()
    await active
  })

  test("interruption releases the pin so later traffic can reclaim the state", async () => {
    let clock = 0
    const stores = Array.from({ length: 6 }, () => new Map<string, unknown>())
    const retention = make(stores, { now: () => clock, forgivenessMs: 1_000 })
    const interrupted = await Effect.runPromiseExit(
      retention.withSession(
        "interrupted",
        Effect.sync(() => {
          for (const store of stores) store.set("interrupted", { retained: true })
        }).pipe(Effect.andThen(Effect.interrupt)),
      ),
    )
    expect(interrupted._tag).toBe("Failure")
    clock = 1_001
    await Effect.runPromise(retention.withSession("trigger", Effect.void))
    expect(stores.every((store) => !store.has("interrupted"))).toBe(true)
  })
})
