import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Git } from "@/git"
import { Pressure } from "@/storage/pressure"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { settingsStub, type SettingsState } from "../storage/settings-stub"

// The mechanical half of the resource-pressure primitive (todo.md ruling 1 — an invariant whose
// violation compiles green does not exist until a test says so). Three invariants are pinned here and
// each is negative-controlled in the report that landed this file:
//
//  1. an UNMEASURABLE probe reports `known: false`, and never a number — most of all never 0, because
//     "0 bytes free" reads as "the disk is full" and would make a healthy host refuse work (ruling 2);
//  2. the aggregate level of nothing-measurable is `unknown`, never `ok` — an unavailable subsystem
//     names itself rather than voting green (ruling 2 again);
//  3. the thresholds are read THROUGH THE STORE at the point of use, so raising a floor takes effect on
//     the next probe with no restart (ruling 3 — a settings change is not a reboot).
//
// Everything platform-specific is exercised through an injected reader, so the Linux and cgroup paths
// are covered on this Windows box. What is NOT covered here is the real syscall behaviour on Linux and
// macOS — see the report's UNVERIFIED section.

const GIB = 1024 ** 3

// A plausible Win32_OperatingSystem answer: 27.4 GB committed of a 44.7 GB limit — the real shape of
// this machine, in KILOBYTES, which is the unit that makes a 1024x error look like plenty of room.
const WINDOWS_STDOUT = "28721872\r\n46890040\r\n"

const MEMINFO = [
  "MemTotal:       16000000 kB",
  "MemFree:          500000 kB",
  "MemAvailable:    4000000 kB",
  "SwapTotal:       2000000 kB",
  "SwapFree:        1000000 kB",
  "",
].join("\n")

/** A fake /proc + /sys, so the Linux dispatch is testable from anywhere. */
const reader =
  (files: Record<string, string>): Pressure.FileReader =>
  (target) =>
    files[target]

const statfsOf = (bsize: number, blocks: number, bavail: number): Pressure.Statfs => {
  return () => ({ bsize, blocks, bavail })
}

const okThresholds: Pressure.Thresholds = Pressure.DEFAULT_THRESHOLDS
const defaultResolved: Pressure.ResolvedThresholds = { thresholds: okThresholds, source: "default" }

describe("Pressure — memory probes", () => {
  test("interprets the Windows commit pair in kilobytes", () => {
    const reading = Pressure.windowsMemory(WINDOWS_STDOUT)
    expect(reading.known).toBe(true)
    if (!reading.known) throw new Error("unreachable")
    expect(reading.source).toBe("windows-commit")
    expect(reading.usedBytes).toBe(28_721_872 * 1024)
    expect(reading.limitBytes).toBe(46_890_040 * 1024)
    // The operator has to be able to re-run it — todo/resource-pressure.md ②.
    expect(reading.crosscheck).toContain("Win32_OperatingSystem")
  })

  test("a probe that could not run is unknown, and carries NO number at all", () => {
    for (const stdout of [undefined, "", "not-a-number\r\n"]) {
      const reading = Pressure.windowsMemory(stdout)
      expect(reading.known).toBe(false)
      if (reading.known) throw new Error("unreachable")
      expect(reading.reason).toContain("unavailable")
      // The load-bearing assertion: unknown is not 0. `usedBytes` must be ABSENT, not zero — a
      // consumer doing `reading.usedBytes ?? 0` on an unknown is the fabricated-fault bug.
      expect(Object.hasOwn(reading, "usedBytes")).toBe(false)
      expect(Object.hasOwn(reading, "limitBytes")).toBe(false)
    }
  })

  test("Linux prefers the cgroup v2 limit over host RAM", () => {
    const reading = Pressure.linuxMemory(
      reader({
        "/proc/meminfo": MEMINFO,
        "/proc/self/cgroup": "0::/user.slice/session.scope\n",
        "/sys/fs/cgroup/user.slice/session.scope/memory.max": "4000000000\n",
        "/sys/fs/cgroup/user.slice/session.scope/memory.current": "3000000000\n",
      }),
    )
    expect(reading.known).toBe(true)
    if (!reading.known) throw new Error("unreachable")
    expect(reading.source).toBe("linux-cgroup-v2")
    expect(reading.limitBytes).toBe(4_000_000_000)
    expect(reading.usedBytes).toBe(3_000_000_000)
  })

  test("an uncapped cgroup falls through to the host figures instead of reporting infinity", () => {
    const reading = Pressure.linuxMemory(
      reader({
        "/proc/meminfo": MEMINFO,
        "/proc/self/cgroup": "0::/\n",
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/memory.current": "800000000\n",
      }),
    )
    expect(reading.known).toBe(true)
    if (!reading.known) throw new Error("unreachable")
    expect(reading.source).toBe("linux-meminfo")
    // Swap counts on both sides: limit = MemTotal + SwapTotal, used = limit - (MemAvailable + SwapFree).
    expect(reading.limitBytes).toBe((16_000_000 + 2_000_000) * 1024)
    expect(reading.usedBytes).toBe((18_000_000 - (4_000_000 + 1_000_000)) * 1024)
  })

  test("cgroup v1's ~2^63 'no limit' sentinel is not mistaken for a cap", () => {
    const files = {
      "/proc/meminfo": MEMINFO,
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1000000000\n",
    }
    expect(Pressure.linuxMemory(reader(files)).known).toBe(true)
    const uncapped = Pressure.linuxMemory(reader(files))
    if (!uncapped.known) throw new Error("unreachable")
    expect(uncapped.source).toBe("linux-meminfo")

    const capped = Pressure.linuxMemory(
      reader({ ...files, "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2000000000\n" }),
    )
    if (!capped.known) throw new Error("unreachable")
    expect(capped.source).toBe("linux-cgroup-v1")
    expect(capped.limitBytes).toBe(2_000_000_000)
  })

  test("a Linux host with no readable /proc/meminfo is unknown, not zero", () => {
    const reading = Pressure.linuxMemory(reader({}))
    expect(reading.known).toBe(false)
    if (reading.known) throw new Error("unreachable")
    expect(reading.reason).toContain("/proc/meminfo")
    expect(Object.hasOwn(reading, "usedBytes")).toBe(false)
  })

  test("macOS says out loud that it is not measured", () => {
    expect(Pressure.DARWIN_MEMORY.known).toBe(false)
    expect(Pressure.DARWIN_MEMORY.reason).toContain("macOS")
    expect(Object.hasOwn(Pressure.DARWIN_MEMORY, "usedBytes")).toBe(false)
  })
})

describe("Pressure — disk", () => {
  test("reports free and total bytes from the block counts", () => {
    const reading = Pressure.disk("/anywhere", statfsOf(4096, 1000, 250))
    expect(reading.known).toBe(true)
    if (!reading.known) throw new Error("unreachable")
    expect(reading.freeBytes).toBe(250 * 4096)
    expect(reading.totalBytes).toBe(1000 * 4096)
  })

  test("a genuinely full volume is a KNOWN zero — the opposite fact from an unknown", () => {
    const reading = Pressure.disk("/full", statfsOf(4096, 1000, 0))
    expect(reading.known).toBe(true)
    if (!reading.known) throw new Error("unreachable")
    expect(reading.freeBytes).toBe(0)
    expect(Pressure.diskLevel(reading, okThresholds)).toBe("floor")
  })

  test("a filesystem that reports no block size is UNKNOWN, never 0 bytes free", () => {
    const reading = Pressure.disk("/opaque", statfsOf(0, 0, 0))
    expect(reading.known).toBe(false)
    if (reading.known) throw new Error("unreachable")
    expect(reading.reason).toContain("block size")
    // The whole point: `bavail * bsize` would have been 0 here, and 0 reads as "disk full".
    expect(Object.hasOwn(reading, "freeBytes")).toBe(false)
    expect(Object.hasOwn(reading, "totalBytes")).toBe(false)
  })

  test("an instance directory that does not exist yet measures its nearest existing ancestor", () => {
    const root = path.parse(process.cwd()).root
    const missing = path.join(process.cwd(), "no-such-dir-" + crypto.randomUUID(), "deeper")
    const reading = Pressure.disk(missing)
    expect(reading.known).toBe(true)
    if (!reading.known) throw new Error("unreachable")
    expect(reading.path).toBe(missing)
    expect(reading.measuredPath).not.toBe(missing)
    expect(missing.startsWith(reading.measuredPath)).toBe(true)
    expect(reading.measuredPath.startsWith(root)).toBe(true)
    expect(reading.freeBytes).toBeGreaterThan(0)
  })

  test("a statfs that always throws is unknown, with no fabricated numbers", () => {
    const reading = Pressure.disk("/gone", () => {
      throw new Error("ENOENT")
    })
    expect(reading.known).toBe(false)
    if (reading.known) throw new Error("unreachable")
    expect(Object.hasOwn(reading, "freeBytes")).toBe(false)
  })
})

describe("Pressure — thresholds", () => {
  test("an absent config value is the shipped default", () => {
    const absent = Pressure.resolveThresholds(undefined)
    expect(absent).toEqual({ thresholds: Pressure.DEFAULT_THRESHOLDS, source: "default" })
    // An empty object IS a stored value — it just overrides nothing.
    expect(Pressure.resolveThresholds({})).toEqual({ thresholds: Pressure.DEFAULT_THRESHOLDS, source: "config" })
  })

  test("the warning line matches heavy-guard's COMMIT_CEILING, so the two gates agree", () => {
    // todo/resource-pressure.md ②: if the Storage row and the dev guard draw different lines, the
    // operator has two numbers and no way to reconcile them.
    expect(Pressure.DEFAULT_THRESHOLDS.warning.memoryUsedFraction).toBe(0.75)
    expect(Pressure.DEFAULT_THRESHOLDS.floor.memoryUsedFraction).toBeGreaterThan(
      Pressure.DEFAULT_THRESHOLDS.warning.memoryUsedFraction,
    )
    expect(Pressure.DEFAULT_THRESHOLDS.floor.diskFreeBytes).toBeLessThan(
      Pressure.DEFAULT_THRESHOLDS.warning.diskFreeBytes,
    )
  })

  test("an override applies FIELD BY FIELD — setting a disk floor keeps the memory line", () => {
    const resolved = Pressure.resolveThresholds({ floor: { disk_free_bytes: 5 * GIB } })
    expect(resolved.source).toBe("config")
    expect(resolved.thresholds.floor.diskFreeBytes).toBe(5 * GIB)
    expect(resolved.thresholds.floor.memoryUsedFraction).toBe(Pressure.DEFAULT_THRESHOLDS.floor.memoryUsedFraction)
    expect(resolved.thresholds.warning).toEqual(Pressure.DEFAULT_THRESHOLDS.warning)
  })

  test("a nonsense threshold falls back to the default AND says so, rather than disarming the guard", () => {
    // A fraction of 0 or 5 is not a strict setting, it is a disabled one — and a malformed value must
    // not be able to take the guard down, so the whole value falls back. Silently would be the bug:
    // a user would be certain they had set a floor they do not have.
    for (const bad of [{ floor: { memory_used_fraction: 0 } }, { floor: { memory_used_fraction: 5 } }, "nonsense", 7]) {
      const resolved = Pressure.resolveThresholds(bad)
      expect(resolved.thresholds).toEqual(Pressure.DEFAULT_THRESHOLDS)
      expect(resolved.source).toBe("invalid")
    }
  })

  test("an unreadable setting is named in the report, not swallowed", () => {
    const blind = Pressure.report({
      memory: { known: false, reason: "no probe" },
      disks: [],
      thresholds: Pressure.resolveThresholds({ floor: { memory_used_fraction: 5 } }),
    })
    expect(blind.thresholdsSource).toBe("invalid")
    expect(blind.unavailable.some((line) => line.includes(Pressure.CONFIG_KEY))).toBe(true)
  })
})

describe("Pressure — verdict", () => {
  const known = (usedFraction: number): Pressure.MemoryReading => ({
    known: true,
    source: "windows-commit",
    crosscheck: "x",
    usedBytes: usedFraction * 1000,
    limitBytes: 1000,
  })
  const unknownMemory: Pressure.MemoryReading = { known: false, reason: "no probe" }
  const unknownDisk: Pressure.DiskReading = { known: false, path: "/x", reason: "no statfs" }
  const roomyDisk = Pressure.disk("/roomy", statfsOf(4096, 10_000_000, 10_000_000))

  test("levels rank ok < warning < floor", () => {
    expect(Pressure.memoryLevel(known(0.5), okThresholds)).toBe("ok")
    expect(Pressure.memoryLevel(known(0.8), okThresholds)).toBe("warning")
    expect(Pressure.memoryLevel(known(0.95), okThresholds)).toBe("floor")
  })

  test("an unknown probe does not vote 'ok' — it withdraws and names itself", () => {
    const mixed = Pressure.report({ memory: unknownMemory, disks: [roomyDisk], thresholds: defaultResolved })
    expect(mixed.level).toBe("ok")
    expect(mixed.unavailable).toHaveLength(1)
    expect(mixed.unavailable[0]).toContain("no probe")
  })

  test("when NOTHING can be measured the verdict is 'unknown', not 'ok'", () => {
    const blind = Pressure.report({ memory: unknownMemory, disks: [unknownDisk], thresholds: defaultResolved })
    expect(blind.level).toBe("unknown")
    expect(blind.unavailable).toHaveLength(2)
  })

  test("the worst KNOWN reading decides, across resources", () => {
    const full = Pressure.disk("/full", statfsOf(4096, 1000, 0))
    expect(Pressure.report({ memory: known(0.1), disks: [roomyDisk, full], thresholds: defaultResolved }).level).toBe(
      "floor",
    )
  })
})

// ─── the live probe on THIS host ────────────────────────────────────────────────────────────────

describe("Pressure — this machine", () => {
  test("measures real disk headroom for the current directory", () => {
    const reading = Pressure.disk(process.cwd())
    expect(reading.known).toBe(true)
    if (!reading.known) throw new Error("unreachable")
    expect(reading.freeBytes).toBeGreaterThan(0)
    expect(reading.totalBytes).toBeGreaterThanOrEqual(reading.freeBytes)
  })

  test.skipIf(process.platform !== "win32")(
    "reports the SAME commit limit the OS does (todo/resource-pressure.md ②)",
    async () => {
      Pressure.resetMemoryCache()
      const reading = await Pressure.memory()
      expect(reading.known).toBe(true)
      if (!reading.known) throw new Error("unreachable")

      // Ask the OS independently, in a different shape than the probe's own script. If these two
      // disagree, the primitive is wrong and a number the operator cannot cross-check is worse than none.
      const proc = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize"],
        { encoding: "utf8", timeout: 15_000 },
      )
      expect(proc.status).toBe(0)
      expect(reading.limitBytes).toBe(Number(proc.stdout.trim()) * 1024)
      expect(reading.usedBytes).toBeGreaterThan(0)
      expect(reading.usedBytes).toBeLessThan(reading.limitBytes * 2)
    },
    30_000,
  )

  test("a second call inside the cache window does not re-probe", async () => {
    Pressure.resetMemoryCache()
    const first = await Pressure.memory()
    const started = Date.now()
    const second = await Pressure.memory()
    // Same object identity proves the cache served it — a re-probe builds a new reading.
    expect(second).toBe(first)
    expect(Date.now() - started).toBeLessThan(100)
  }, 30_000)
})

// ─── ruling 3: the threshold is read THROUGH THE STORE, at the point of use ─────────────────────

const settings: SettingsState = { current: {} }

// `Layer.fresh` because Effect memoizes a layer by its INNER reference (AGENTS.md pitfall -1): without
// it this build would resolve to whatever Storage another suite already built.
const it = testEffect(
  Layer.fresh(
    Storage.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Git.defaultLayer),
      Layer.provide(settingsStub(settings)),
    ),
  ),
)

describe("Storage.pressure", () => {
  it.live(
    "picks up a threshold change with NO layer rebuild — a settings change is not a reboot",
    () =>
      Effect.gen(function* () {
        settings.current = {}
        const svc = yield* Storage.Service

        const before = yield* svc.pressure()
        expect(before.thresholds.floor.diskFreeBytes).toBe(Pressure.DEFAULT_THRESHOLDS.floor.diskFreeBytes)

        // The store changes underneath the SAME service instance. Nothing is rebuilt, nothing restarts.
        settings.current = {
          [Pressure.CONFIG_KEY]: { floor: { disk_free_bytes: 9 * GIB }, warning: { memory_used_fraction: 0.5 } },
        }

        const after = yield* svc.pressure()
        expect(after.thresholds.floor.diskFreeBytes).toBe(9 * GIB)
        expect(after.thresholds.warning.memoryUsedFraction).toBe(0.5)
        // Untouched fields keep the shipped line.
        expect(after.thresholds.floor.memoryUsedFraction).toBe(Pressure.DEFAULT_THRESHOLDS.floor.memoryUsedFraction)
      }),
    30_000,
  )

  it.live(
    "reports every instance volume and never a fabricated zero",
    () =>
      Effect.gen(function* () {
        settings.current = {}
        const svc = yield* Storage.Service
        const result = yield* svc.pressure()

        expect(result.disks.length).toBeGreaterThan(0)
        for (const entry of result.disks) {
          if (entry.known) expect(entry.freeBytes).toBeGreaterThan(0)
          else expect(Object.hasOwn(entry, "freeBytes")).toBe(false)
        }
        // Whatever this host is, the verdict is one of the four and the unavailable list explains any gap.
        expect(["ok", "warning", "floor", "unknown"]).toContain(result.level)
        if (result.level === "unknown") expect(result.unavailable.length).toBeGreaterThan(0)
      }),
    30_000,
  )
})
