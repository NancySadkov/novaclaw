/**
 * The attribution claim, asserted rather than asserted-about.
 *
 * `attribute()` is the only place in the sampler where a judgement is made — the platform loops just
 * transcribe the process table. So every case that has ever produced a wrong number gets a row here,
 * and, per todo/test-speed.md's standing rule, **each positive is paired with the negative control
 * that must fail**: an attributor that always answers "mine" is worse than counting by name, because
 * it is wrong with the same confidence and no longer says so.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { attribute, MAX_TICKS, POSIX_LOOP, WINDOWS_LOOP } from "./peak-sampler"

/** `<tickMs> <hostPct> [<pid>,<startMs>,<commitMb>,<workingSetMb> ...]`. */
const tick = (ms: number, hostPct: number, procs: ReadonlyArray<readonly [number, number, number, number?]>) =>
  [ms, hostPct, ...procs.map(([pid, start, mb, workingSet = mb]) => `${pid},${start},${mb},${workingSet}`)].join(" ")

const timeline = (...rows: string[]) => rows.join("\n") + "\n"

describe("attribute", () => {
  it("counts a unit's OWN spawned workers — the sixteen-flock-worker case", () => {
    // core's shape: its own test process plus the `const n = 16` workers flock.test.ts spawns with
    // process.execPath (= bun.exe under `bun test`). All born inside the window.
    const workers = Array.from({ length: 16 }, (_, i) => [200 + i, 1_050, 582] as const)
    const sample = attribute(
      timeline(tick(1_100, 50, [[100, 1_020, 7_330], ...workers]), tick(1_300, 51, [[100, 1_020, 7_330]])),
      1_000,
      2_000,
    )
    expect(sample.treeMb).toBe(7_330 + 16 * 582)
    expect(sample.workingSetMb).toBe(7_330 + 16 * 582)
    expect(sample.ticks).toBe(2)
    expect(sample.ownTicks).toBe(2)
    expect(sample.foreignMb).toBeUndefined()
  })

  it("NEGATIVE CONTROL — the same processes born BEFORE the window are attributed to nobody", () => {
    // Byte-identical to the case above except for the birth times. If this returns the same number,
    // the attributor is not attributing: it is summing by name again.
    const workers = Array.from({ length: 16 }, (_, i) => [200 + i, 990, 582] as const)
    const sample = attribute(timeline(tick(1_100, 50, [[100, 900, 7_330], ...workers])), 1_000, 2_000)
    expect(sample.treeMb).toBeUndefined()
    expect(sample.foreignMb).toBe(7_330 + 16 * 582)
    expect(sample.ticks).toBe(1)
    expect(sample.ownTicks).toBe(0)
  })

  it("excludes the `bun run test` parent shim, which is why schema recorded 43 MB of nothing", () => {
    // The gate's real short-unit shape: the shim (born long before the gate) is alive for the whole
    // run, and the unit's own child is caught by exactly one tick. Before this change the recorded
    // peak for `schema` was 43 — the shim alone — and a `ratio: 0.113` was derived from it.
    const shim = [7, 1, 43] as const
    const sample = attribute(
      timeline(tick(10_050, 40, [shim]), tick(10_250, 40, [shim, [900, 10_100, 96]]), tick(10_450, 40, [shim])),
      10_000,
      10_500,
    )
    expect(sample.treeMb).toBe(96)
    expect(sample.foreignMb).toBe(43)
    expect(sample.ownTicks).toBe(1)
  })

  it("NEGATIVE CONTROL — a window that caught only the shim reports NO peak, not 43", () => {
    const sample = attribute(timeline(tick(10_050, 40, [[7, 1, 43]]), tick(10_250, 40, [[7, 1, 43]])), 10_000, 10_500)
    expect(sample.treeMb).toBeUndefined()
    expect(sample.ownTicks).toBe(0)
    expect(sample.ticks).toBe(2)
    expect(sample.foreignMb).toBe(43)
  })

  it("survives PID REUSE — the same pid, two lives, judged separately", () => {
    // The exact shape that manufactured a phantom 183-second 786 MB stray: PID 12528 appeared twice,
    // minutes apart. A set-of-PIDs membership test cannot tell these apart; a birth time can.
    const before = attribute(timeline(tick(5_100, 40, [[12_528, 4_000, 786]])), 5_000, 5_500)
    const during = attribute(timeline(tick(5_100, 40, [[12_528, 5_050, 786]])), 5_000, 5_500)
    expect(before.treeMb).toBeUndefined()
    expect(before.foreignMb).toBe(786)
    expect(during.treeMb).toBe(786)
    expect(during.foreignMb).toBeUndefined()
  })

  it("does not let a previous unit's dying child bleed into the next window", () => {
    const sample = attribute(
      timeline(
        tick(2_050, 40, [
          [300, 1_500, 1_900],
          [301, 2_010, 120],
        ]),
      ),
      2_000,
      2_500,
    )
    expect(sample.treeMb).toBe(120)
    expect(sample.foreignMb).toBe(1_900)
  })

  it("treats an UNDATEABLE process as foreign, never as ours", () => {
    // -1 is what the loops write when StartTime could not be read. Claiming it would over-report,
    // which is the direction that feeds the memory ladder a number belonging to something else.
    const sample = attribute(timeline(tick(3_100, 40, [[400, -1, 2_048]])), 3_000, 3_500)
    expect(sample.treeMb).toBeUndefined()
    expect(sample.foreignMb).toBe(2_048)
  })

  it("takes the PEAK of the per-tick sum, not the sum of the peaks", () => {
    const sample = attribute(
      timeline(
        tick(4_100, 40, [[500, 4_010, 100]]),
        tick(4_300, 40, [
          [500, 4_010, 400],
          [501, 4_200, 300],
        ]),
        tick(4_500, 40, [[500, 4_010, 150]]),
      ),
      4_000,
      5_000,
    )
    expect(sample.treeMb).toBe(700)
  })

  it("records resident working set beside commit without confusing the two", () => {
    const sample = attribute(
      timeline(tick(4_100, 40, [[500, 4_010, 1_000, 250]]), tick(4_300, 40, [[500, 4_010, 1_200, 300]])),
      4_000,
      5_000,
    )
    expect(sample.treeMb).toBe(1_200)
    expect(sample.workingSetMb).toBe(300)
  })

  it("ignores ticks outside the window at both ends, inclusively bounded", () => {
    const rows = timeline(
      tick(900, 40, [[600, 950, 500]]),
      tick(1_000, 40, [[600, 950, 500]]),
      tick(2_000, 40, [[600, 950, 500]]),
      tick(2_100, 40, [[600, 950, 500]]),
    )
    expect(attribute(rows, 1_000, 2_000).ticks).toBe(2)
  })

  it("reports host commit from every tick in the window, independent of attribution", () => {
    // The host series answers a different question (was the BOX paging), so it must survive a window
    // in which nothing at all belonged to the unit — that is precisely when a reader needs it.
    const sample = attribute(timeline(tick(1_100, 61, [[7, 1, 43]]), tick(1_300, 94, [[7, 1, 43]])), 1_000, 2_000)
    expect(sample.hostCommitPct).toBe(94)
    expect(sample.treeMb).toBeUndefined()
  })

  it("an empty window is ticks 0 / ownTicks 0, with no numbers invented", () => {
    const sample = attribute(timeline(tick(100, 40, [[700, 50, 900]])), 1_000, 2_000)
    expect(sample).toEqual({ ticks: 0, ownTicks: 0 })
  })

  it("skips malformed rows and malformed entries rather than counting them", () => {
    const sample = attribute(
      ["not a row at all", tick(1_100, 40, [[800, 1_050, 250]]) + " garbage 9,9", ""].join("\n"),
      1_000,
      2_000,
    )
    expect(sample.ticks).toBe(1)
    expect(sample.treeMb).toBe(250)
  })

  it("a tick with no processes at all still counts as a tick", () => {
    // This is how `unsampled` and `measured-nothing` stay distinguishable: the sampler was alive and
    // looking, and there was genuinely nothing of ours to see.
    const sample = attribute(timeline(tick(1_100, 40, []), tick(1_300, 40, [])), 1_000, 2_000)
    expect(sample.ticks).toBe(2)
    expect(sample.ownTicks).toBe(0)
    expect(sample.treeMb).toBeUndefined()
  })
})

/**
 * The sampler's own bounds, EXERCISED rather than described.
 *
 * The loop used to be `while ($true)`, and its only way out was a `stop()` its parent might never
 * reach — a signal runs no handler, and the paths that actually produce an orphan here are memory
 * refusals on a box that is already short of memory. So the bound moved into the loop, and a bound
 * is only real if something has watched it fire.
 *
 * Both tests run the REAL loop text, not a paraphrase of it: they are the only thing standing
 * between this file and a shell quoting mistake that silently restores `while ($true)`.
 */
describe("the sampled loop bounds itself", () => {
  const win = process.platform === "win32"
  /** Run the platform loop for real and resolve with its exit code and how long it took. */
  const runLoop = (rootPid: number, maxTicks: number) => {
    const dir = mkdtempSync(join(os.tmpdir(), "novaclaw-peak-test-"))
    const file = join(dir, "timeline.txt")
    const started = Date.now()
    const child = win
      ? spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LOOP(file, rootPid, maxTicks)], {
          stdio: "ignore",
          windowsHide: true,
        })
      : spawn("sh", ["-c", POSIX_LOOP(file, rootPid, maxTicks)], { stdio: "ignore" })
    return new Promise<{ ms: number; rows: number }>((resolve) => {
      child.on("exit", () => {
        let rows = 0
        try {
          rows = readFileSync(file, "utf8").split("\n").filter(Boolean).length
        } catch {
          /* the loop may legitimately have written nothing */
        }
        rmSync(dir, { recursive: true, force: true })
        resolve({ ms: Date.now() - started, rows })
      })
    })
  }

  /** A pid that is certainly gone: spawn something trivial and wait for it to die. */
  const deadPid = async () => {
    const probe = win ? spawn("cmd", ["/c", "exit", "0"], { stdio: "ignore", windowsHide: true }) : spawn("true")
    const pid = probe.pid
    await new Promise<void>((resolve) => probe.on("exit", () => resolve()))
    if (pid === undefined) throw new Error("could not obtain a pid to bury")
    return pid
  }

  it("🔴 stops on its own when the parent it serves is gone — the orphan case", async () => {
    // The generous tick ceiling is the point: nothing but the LIVENESS check can end this run, so
    // an exit here cannot be the ceiling passing for the bound under test.
    const { ms } = await runLoop(await deadPid(), MAX_TICKS)
    expect(ms).toBeLessThan(10_000)
  }, 20_000)

  it("🔴 stops at the tick ceiling even while its parent is alive — the PID-reuse case", async () => {
    // NEGATIVE CONTROL for the test above: same loop, same shell, a parent that is definitely
    // ALIVE (this process). If it still exits, the liveness check is not what ended the run above;
    // if it never exits, `MAX_TICKS` is not a bound. Five ticks at 200 ms is ~1 s of sampling —
    // enough to see the ceiling arrive, and the test's whole cost is that second.
    const { ms, rows } = await runLoop(process.pid, 5)
    expect(ms).toBeLessThan(20_000)
    // …and it really did sample: an exit with an empty timeline would mean the loop died rather
    // than finished, which would make the assertion above true for the wrong reason.
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThanOrEqual(5)
  }, 30_000)

  it("the ceiling is above any real run — a --full gate is 16-25 minutes", () => {
    // A bound that could fire mid-gate would truncate the measurement it exists to protect.
    expect((MAX_TICKS * 200) / 60_000).toBeGreaterThanOrEqual(45)
  })
})
