import { describe, expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import { SpawnAdmission } from "@novaclaw/core/session/spawn-admission"

/**
 * The seam between the kernel's spawn guard and the instance's memory probe.
 *
 * 🔴 `spawner.ts` enforced three fork-bomb bounds and never asked whether the HOST could afford
 * another sub-agent. All three are per-parent, so they compose into no instance-wide limit, and
 * `MAX_SPAWN_CHILDREN` (16) sits ~2.7x above the only observed failure — six sub-agents holding a
 * sixth of a 1 MB file each took a dev instance down twice
 * (`notes/reports/fleet-bounds-2026-08-23.md`).
 *
 * Two default-ADMIT behaviours below are the ones worth pinning, because each would otherwise turn a
 * missing or misbehaving probe into a fleet-wide outage.
 */

const run = <A>(effect: Effect.Effect<A, never, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

describe("spawn admission", () => {
  test("NOBODY REGISTERED admits — a CLI or a test graph has no probe", async () => {
    // The pre-existing behaviour, and the stance `agent/removal.ts` takes for the same reason.
    expect(await Effect.runPromise(SpawnAdmission.check())).toEqual({ refuse: undefined })
  })

  test("a probe that refuses is honoured, and its words come back", async () => {
    const verdict = await run(
      Effect.gen(function* () {
        yield* SpawnAdmission.register(() => Effect.succeed({ refuse: "host memory is at the floor" }))
        return yield* SpawnAdmission.check()
      }),
    )
    expect(verdict.refuse).toBe("host memory is at the floor")
  })

  test("a probe that THROWS admits — a flaky reading must not become an outage", async () => {
    // 🔴 The probe reads host memory, which is precisely what misbehaves under pressure. Turning
    // "the probe failed" into "no agent may spawn" would make the symptom cause the outage.
    const verdict = await run(
      Effect.gen(function* () {
        yield* SpawnAdmission.register(() => Effect.die(new Error("probe exploded")))
        return yield* SpawnAdmission.check()
      }),
    )
    expect(verdict.refuse).toBeUndefined()
  })

  test("the registration is scoped — leaving the scope removes the probe", async () => {
    await run(
      Effect.gen(function* () {
        yield* SpawnAdmission.register(() => Effect.succeed({ refuse: "no" }))
        expect(SpawnAdmission.registered()).toBe(1)
      }),
    )
    // A probe that outlived its instance would refuse spawns for the next one.
    expect(SpawnAdmission.registered()).toBe(0)
  })
})
