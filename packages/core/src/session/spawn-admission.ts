export * as SpawnAdmission from "./spawn-admission"

import { Effect } from "effect"

/**
 * WHETHER THE HOST CAN AFFORD ANOTHER SUB-AGENT — the seam between the kernel's spawn guard and the
 * instance's memory probe.
 *
 * 🔴 **Why a seam and not an import.** `spawner.ts` is kernel; the probe that can answer *"how much
 * memory is left"* is `novaclaw/src/storage/pressure.ts`, one package ABOVE it (`novaclaw` depends on
 * `@novaclaw/core`, never the reverse). So spawn cannot ask directly, and until now it did not ask at
 * all: `spawner.ts` contained no reference to pressure, while enforcing three fork-bomb bounds that
 * are all per-PARENT and therefore compose into no instance-wide limit at all.
 *
 * Measured context (`notes/reports/fleet-bounds-2026-08-23.md`): `MAX_SPAWN_CHILDREN` permits 16
 * concurrent children per parent, while **six** sub-agents holding a sixth of a 1 MB file each took
 * a dev instance down twice with `oh no: Bun has crashed`. The configured bound sits ~2.7× above the
 * only failure anybody has written down.
 *
 * ⚠️ **This carries NO threshold of its own, deliberately.** The registered probe returns the
 * instance's own verdict; a number restated here would be a second definition of "strained", and two
 * places deciding that is how a guard and the thing it guards drift apart. The kernel asks a
 * question; the instance owns the answer.
 *
 * ⚠️ **Nobody registered is NOT a refusal** — the same stance `agent/removal.ts` takes. A CLI run, a
 * test harness or any graph without the instance's storage layer has no probe, and a spawn guard that
 * denied by default would break every one of them. Silence means "no reason to refuse", which is also
 * what the pre-existing behaviour was.
 */

/** The instance's answer. `undefined` from a probe means "cannot tell", which admits. */
export interface Verdict {
  /** Refuse the spawn, and say why in words a person can act on. */
  readonly refuse: string | undefined
}

type Probe = () => Effect.Effect<Verdict>

const probes = new Set<{ readonly probe: Probe }>()

/** Register the instance's probe for the life of the scope. */
export const register = (probe: Probe) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const entry = { probe }
      probes.add(entry)
      return entry
    }),
    (entry) => Effect.sync(() => probes.delete(entry)),
  )

/** How many probes are listening — for tests and for health surfaces, never for control flow. */
export const registered = (): number => probes.size

/**
 * Ask every registered probe. The FIRST refusal wins.
 *
 * ⚠️ A probe that fails is treated as silence rather than as a refusal. The probe reads host memory,
 * which is exactly the thing that misbehaves under pressure — turning "the probe threw" into "no
 * agent may spawn" would make a flaky reading a fleet-wide outage.
 */
export const check = (): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    for (const entry of probes) {
      const verdict = yield* entry.probe().pipe(Effect.catchCause(() => Effect.succeed({ refuse: undefined })))
      if (verdict.refuse !== undefined) return verdict
    }
    return { refuse: undefined }
  })
