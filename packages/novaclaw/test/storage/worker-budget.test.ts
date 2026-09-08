import { describe, expect, test } from "bun:test"
import { WorkerBudget } from "@/storage/worker-budget"
import { WorkerCommit } from "@/storage/worker-commit"

/**
 * The shed decision, and the instrument it reads.
 *
 * Both halves are pure on purpose: the rule that decides whether a process dies should be readable
 * and testable without a fleet, a clock, or the memory pressure it exists to survive. Building
 * pressure to test a memory guard is how a guard's own test takes the host down.
 */

const MIB = 1024 * 1024
const limits = { perWorkerBytes: 2048 * MIB, fleetBytes: 6144 * MIB, consecutiveSamples: 3 }

test("the fleet ceiling leaves two thirds of host memory outside session workers", () => {
  expect(WorkerBudget.fleetLimitBytes(12 * 1024 * MIB)).toBe(4 * 1024 * MIB)
  expect(WorkerBudget.fleetLimitBytes(3 * 1024 * MIB)).toBe(2 * 1024 * MIB)
})

describe("who gets shed", () => {
  test("a healthy fleet is left alone", () => {
    const readings = [
      { pid: 1, bytes: 900 * MIB },
      { pid: 2, bytes: 800 * MIB },
    ]
    expect(WorkerBudget.decide({ readings, streak: 5, limits })).toEqual({ action: "none" })
  })

  test("no readings is NOT a reason to kill anything", () => {
    // ⚠️ An unmeasurable fleet must never read as a failing one — the mirror of `pressure.ts`'s rule
    // that an unmeasurable host must not read as healthy. Shedding on an empty sample would turn a
    // flaky reading into an outage.
    expect(WorkerBudget.decide({ readings: [], streak: 99, limits })).toEqual({ action: "none" })
  })

  test("a first breach WARNS rather than killing", () => {
    // The false-kill guard. A worker returning from a spike must not die for the spike.
    const readings = [{ pid: 7, bytes: 3000 * MIB }]
    const decision = WorkerBudget.decide({ readings, streak: 0, limits })
    expect(decision.action).toBe("warn")
    expect(decision.action === "warn" && decision.pid).toBe(7)
    expect(decision.action === "warn" && decision.breach).toBe("per-worker")
  })

  test("a breach that PERSISTS sheds the offender", () => {
    const readings = [{ pid: 7, bytes: 3000 * MIB }]
    // streak 2 + this sample = 3 consecutive, which is the configured limit.
    expect(WorkerBudget.decide({ readings, streak: 2, limits })).toEqual({
      action: "shed",
      breach: "per-worker",
      pid: 7,
      reason: "session worker 7 holds 3000 MiB against a 2048 MiB ceiling",
      limitBytes: limits.perWorkerBytes,
    })
  })

  test("🔴 a fleet that is individually fine but TOGETHER over is caught", () => {
    // The bound nothing else in this product expresses: every existing limit is per-worker or
    // per-parent. Each of these is comfortably under the 2048 MiB per-worker ceiling, so every
    // per-worker check passes them — and 4 x 1800 = 7200 MiB is over the 6144 fleet ceiling.
    const readings = [
      { pid: 1, bytes: 1800 * MIB },
      { pid: 2, bytes: 1800 * MIB },
      { pid: 3, bytes: 1800 * MIB },
      { pid: 4, bytes: 1800 * MIB },
    ]
    for (const reading of readings) expect(reading.bytes).toBeLessThan(limits.perWorkerBytes)
    const decision = WorkerBudget.decide({ readings, streak: 2, limits })
    expect(decision.action).toBe("shed")
    expect(decision.action === "shed" && decision.reason).toContain("4 session workers")
    // 🔴 The BREACH KIND, structured — a fleet breach and a runaway lead to different conclusions,
    // and a log carrying only a sentence cannot be filtered on.
    expect(decision.action === "shed" && decision.breach).toBe("fleet")
  })

  test("shedding takes the HEAVIEST — the one that buys room", () => {
    const readings = [
      { pid: 1, bytes: 1000 * MIB },
      { pid: 2, bytes: 4000 * MIB },
      { pid: 3, bytes: 1200 * MIB },
    ]
    expect(WorkerBudget.decide({ readings, streak: 2, limits })).toMatchObject({ action: "shed", pid: 2 })
  })

  test("the reason names the SPECIFIC breach, not 'memory is high'", () => {
    // The two breaches lead to different conclusions — one runaway, or a fleet too large for this
    // host — so a reader must be able to tell which happened.
    const single = WorkerBudget.decide({ readings: [{ pid: 9, bytes: 9000 * MIB }], streak: 9, limits })
    expect(single.action === "shed" && single.reason).toMatch(/worker 9 holds \d+ MiB/)
  })
})

describe("the instrument", () => {
  test("parses pid/bytes pairs and ignores everything else", () => {
    const text = ["PID  Bytes", "1234 5368709120", "", "  99 0  ", "garbage", "-1 500"].join("\n")
    expect(WorkerCommit.parseLines(text)).toEqual([
      { pid: 1234, bytes: 5368709120 },
      { pid: 99, bytes: 0 },
    ])
  })

  test("a zero is a real answer; a non-number is not", () => {
    // A process can legitimately owe nothing yet. Dropping zeros would silently shrink the fleet
    // total and make the sum ceiling read low exactly when workers are starting.
    expect(WorkerCommit.parseLines("5 0")).toEqual([{ pid: 5, bytes: 0 }])
    expect(WorkerCommit.parseLines("5 NaN")).toEqual([])
  })

  test("reads VmRSS out of a /proc status block", () => {
    const status = ["Name:\tbun", "VmSize:\t 9999999 kB", "VmRSS:\t 2621440 kB", "Threads:\t12"].join("\n")
    expect(WorkerCommit.parseProcStatus(status)).toBe(2621440 * 1024)
    expect(WorkerCommit.parseProcStatus("Name:\tbun")).toBeUndefined()
  })

  test("an empty fleet costs NOTHING — no process is spawned", async () => {
    // A memory guard that spawns a shell every tick against an empty fleet is itself the problem.
    const sample = await WorkerCommit.sample([])
    expect(sample.readings).toEqual([])
  })

  test("an unsupported platform says so rather than reporting zero", async () => {
    // ⚠️ "Nothing was measured" and "everything is small" must never be the same answer.
    const sample = await WorkerCommit.sample([1], "aix")
    expect(sample.unavailable).toBeDefined()
    expect(sample.readings).toEqual([])
  })

  test("the metric rides WITH the reading, and differs by platform", async () => {
    // Windows charges commit against a hard system-wide limit; Linux overcommits, so RSS is what
    // predicts exhaustion there. Reporting one number under one name across both would be a lie in
    // whichever direction the reader guessed — so a caller never has to infer it.
    expect((await WorkerCommit.sample([], "win32")).metric).toBe("commit")
    expect((await WorkerCommit.sample([], "linux")).metric).toBe("rss")
  })
})
