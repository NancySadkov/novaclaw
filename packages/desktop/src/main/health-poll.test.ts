import { describe, expect, test } from "bun:test"

import { pollUntilHealthy } from "./health-poll"

/**
 * The invariant: a health poll does not outlive the thing it polls.
 *
 * 🔴 This is a per-SPAWN leak, so one poll proves nothing. The sidecar supervisor calls the spawn
 * path again on every recovery, and the old loop was built fresh each time and cancelled by nothing —
 * `Promise.race` settles the outer promise and leaves the loser running. The cost was therefore the
 * number of times the app had healed itself: a machine that got worse the longer it stayed up, and
 * only under the real use that made it recover. So the assertion below is about N of them at once,
 * and about what the counters do AFTER every one has been stopped.
 */

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("pollUntilHealthy", () => {
  test("N subjects started and N stopped leave zero live polls", async () => {
    const SUBJECTS = 8
    const subjects = Array.from({ length: SUBJECTS }, () => ({ gone: false, probes: 0 }))

    // Real timers on purpose. The claim is that no timer REMAINS, and a fake clock cannot be asked
    // whether the runtime is still holding one — only real elapsed time with a frozen counter can.
    const polls = subjects.map((subject) =>
      pollUntilHealthy({
        probe: async () => {
          subject.probes++
          return false
        },
        cancelled: () => subject.gone,
        intervalMs: 5,
        // Far beyond the test's own lifetime: this case must be decided by cancellation, never by
        // the deadline. A deadline short enough to fire here would make the test pass for the wrong
        // reason and would keep passing with the cancellation check deleted.
        timeoutMs: 600_000,
      }),
    )

    await tick(60)
    const whileAlive = subjects.map((subject) => subject.probes)
    // The instrument works: these polls really were running. Without this the frozen counters below
    // would also be satisfied by a poll that never started.
    expect(whileAlive.every((count) => count > 0)).toBe(true)

    for (const subject of subjects) subject.gone = true
    expect(await Promise.all(polls)).toEqual(Array.from({ length: SUBJECTS }, () => "cancelled" as const))

    const atStop = subjects.map((subject) => subject.probes)
    await tick(120)
    // 120 ms at a 5 ms interval is ~24 further probes per subject if a single timer survived.
    expect(subjects.map((subject) => subject.probes)).toEqual(atStop)
  })

  test("a subject that stays alive and stays silent is bounded by the deadline", async () => {
    // The named leak: a sidecar that answers `ready` and never answers `/global/health`. It never
    // exits, so no exit latch can end this — only the deadline can, and it must REJECT rather than
    // report a health it never observed.
    let probes = 0
    const clock = { at: 0 }

    await expect(
      pollUntilHealthy({
        probe: async () => {
          probes++
          clock.at += 100
          return false
        },
        cancelled: () => false,
        intervalMs: 100,
        timeoutMs: 1_000,
        now: () => clock.at,
        // ⚠️ A bounded stand-in for the sleep, not a no-op. A poll with no deadline and an instant
        // sleep is a tight `await` loop that starves the event loop, so the runner's own timeout
        // never fires and the case HANGS instead of failing — a control that cannot report is not a
        // control. Refusing past the expected count turns "the bound was deleted" into a named
        // assertion failure in milliseconds.
        sleep: async () => {
          if (probes > 20) throw new Error(`the poll ran past its deadline: ${probes} probes`)
        },
      }),
    ).rejects.toThrow("did not pass within 1000ms")

    expect(probes).toBe(10)
  })

  test("the ordinary path still reaches healthy", async () => {
    let probes = 0
    const result = await pollUntilHealthy({
      probe: async () => ++probes >= 3,
      cancelled: () => false,
      intervalMs: 1,
      timeoutMs: 10_000,
    })

    expect(result).toBe("healthy")
    expect(probes).toBe(3)
  })

  test("a subject already gone is never probed at all", async () => {
    let probes = 0
    const result = await pollUntilHealthy({
      probe: async () => {
        probes++
        return true
      },
      cancelled: () => true,
      intervalMs: 1,
      timeoutMs: 10_000,
    })

    expect(result).toBe("cancelled")
    expect(probes).toBe(0)
  })
})
