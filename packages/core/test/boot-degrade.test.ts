/**
 * **The boot must survive a filesystem that refuses it — and the failure must name itself.**
 *
 * Two of the four unconditional boot-killers in
 * `notes/reports/startup-classification-2026-08-07.md` §4.1 live in this package:
 *
 *   · `global.ts` ran **seven unguarded `mkdirSync`s** inside `Effect.sync`, on the most
 *     dependency-central node in the graph, as the first thing the boot does. EACCES/EPERM/EROFS/
 *     ENOSPC on any one of them was a defect nothing could catch.
 *   · `observability.ts` piped **`Layer.orDie` over `Logger.toFile`**, whose error channel is
 *     `PlatformError`. An unwritable log directory killed the boot — in the subsystem you most need
 *     when a boot is failing, and against `` phase 2's own rule that logging must
 *     never take the instance down.
 *
 * Why that class matters more than its size: AGENTS.md's self-healing law — *as long as at least one
 * working model remains, the system must be restorable by asking an agent* — is **void during boot**,
 * because there is no process to ask. Every one of these converts a repairable operational fault into
 * a reinstall.
 *
 * ── why a subprocess, and why the fixture carries its own control ────────────────────────────────
 *
 * `Global.dirs()` caches its answer in a module-level variable and `Observability.layer` caches the
 * open file handle, both **once per process**. So an in-process test cannot poison the home: the
 * first test to touch either has already fixed the answer for every test after it. `fixture/
 * boot-degrade.ts` is the instrument — it imports the real modules in the real order under a home
 * this file arranged.
 *
 * ⚠️ **Every assertion below is paired with the UNGUARDED twin of the same operation, run against the
 * same paths in the same process.** "The boot survived" is trivially true if the poison stopped
 * biting — a permissions quirk, a Windows update, a typo in this file — and a green test that cannot
 * fail is worse than no test. So each case asserts *both* that the raw operation failed and that the
 * guarded one degraded. The `NEGATIVE CONTROL` block at the bottom of this comment records the
 * measurement that the guarded arms are two-valued at all.
 *
 * **NEGATIVE CONTROL, measured 2026-08-07 (win32), by reverting the fix and re-running this fixture:**
 *
 * | reverted to | `booted` | `guardedLogger` |
 * |---|---|---|
 * | `loggers()` → `fileLogger()` + `Layer.orDie` in `observability.ts` (i.e. HEAD~) | **false** | n/a |
 * | the bare `for (…) fsSync.mkdirSync(dir)` loop in `global.ts` | the fixture **threw** before printing | n/a |
 * | the shipped code | **true** | `stderr` |
 */
import { describe, expect, test } from "bun:test"
import fsSync from "node:fs"
import path from "node:path"
import { Global } from "@novaclaw/core/global"
import { tmpdir } from "./fixture/tmpdir"

const FIXTURE = path.join(import.meta.dir, "fixture", "boot-degrade.ts")

interface Report {
  status: Global.DirectoryStatus
  data: string
  log: string
  unguarded: ReadonlyArray<{ directory: string; threw: boolean }>
  unguardedLogger: "failed" | "opened"
  guardedLogger: "stderr" | "file" | "DIED"
  booted: boolean
  logFileContent: string | null
}

/** Boot the fixture under `home` and read back what it observed. */
async function boot(home: string): Promise<{ report: Report; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, FIXTURE], {
    env: { ...process.env, NOVACLAW_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const line = stdout.trim().split("\n").at(-1) ?? ""
  if (!line.startsWith("{"))
    throw new Error(`the boot fixture printed no report (exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`)
  return { report: JSON.parse(line) as Report, stderr, exitCode }
}

describe("Global's directory creation", () => {
  test("the seven directories are named by a pure function, and creating them reports rather than throws", async () => {
    await using dir = await tmpdir()
    const layout = {
      data: path.join(dir.path, "data"),
      cache: path.join(dir.path, "cache"),
      config: path.join(dir.path, "config"),
      state: path.join(dir.path, "state"),
    }
    const wanted = Global.directoriesOf(layout, path.join(dir.path, "tmp"))
    expect(wanted).toHaveLength(7)
    expect(Global.ensureDirectories(wanted)).toEqual([])
    expect(wanted.every((entry) => fsSync.statSync(entry).isDirectory())).toBe(true)

    // …and the same call against a root that cannot exist returns faults instead of throwing on the
    // first one, so a repair sees the whole picture rather than the alphabetically-first problem.
    const blocker = path.join(dir.path, "blocker")
    fsSync.writeFileSync(blocker, "not a directory")
    const doomed = [path.join(blocker, "a"), path.join(blocker, "b")]
    // The control: the raw syscall this replaced really does throw against these paths.
    expect(() => fsSync.mkdirSync(doomed[0]!, { recursive: true })).toThrow()
    const faults = Global.ensureDirectories(doomed)
    expect(faults.map((fault) => fault.directory)).toEqual(doomed)
    expect(faults.every((fault) => fault.message.length > 0)).toBe(true)
  })

  test("an unusable home relocates to the emergency root and says so — the boot still comes up", async () => {
    await using dir = await tmpdir()
    const blocker = path.join(dir.path, "blocker")
    fsSync.writeFileSync(blocker, "not a directory")

    const { report, stderr, exitCode } = await boot(path.join(blocker, "home"))

    // The control: the pre-fix loop, over the same paths, in the same process.
    expect(report.unguarded.length).toBeGreaterThan(0)
    expect(report.unguarded.every((entry) => entry.threw)).toBe(true)

    // The claim.
    expect(exitCode).toBe(0)
    expect(report.booted).toBe(true)
    expect(report.status.state).toBe("relocated")
    if (report.status.state !== "relocated") throw new Error("unreachable")
    expect(report.data.startsWith(report.status.root)).toBe(true)
    // Ruling 2: an unavailable subsystem names itself. Every failed directory is on the line, with
    // the reason, and the documented way out.
    expect(report.status.failures.length).toBeGreaterThanOrEqual(3)
    expect(stderr).toContain("[novaclaw] WARNING")
    expect(stderr).toContain(path.join(blocker, "home", "data"))
    expect(stderr).toContain("--home <dir>")
  })

  test("a healthy home is untouched — no warning, no relocation (negative control)", async () => {
    await using dir = await tmpdir()
    const { report, stderr, exitCode } = await boot(path.join(dir.path, "home"))

    expect(exitCode).toBe(0)
    expect(report.status.state).toBe("ok")
    expect(report.booted).toBe(true)
    expect(report.unguarded.every((entry) => entry.threw)).toBe(false)
    expect(report.unguardedLogger).toBe("opened")
    expect(report.guardedLogger).toBe("file")
    expect(stderr).not.toContain("[novaclaw] WARNING")

    // ⭐ The end-to-end claim for Phase 2's writer, and the one that cannot be faked by a layer that
    // merely BUILDS: the line the real `Observability.layer` emitted is in `<data>/log/novaclaw.log`,
    // in the production logfmt, flushed by the scope release. A sink that wrote nowhere would pass
    // every other assertion in this file.
    expect(report.logFileContent).toContain('message="boot-degrade probe reached the logger"')
    expect(report.logFileContent).toContain("level=INFO")
    expect(report.logFileContent!.endsWith("\n")).toBe(true)
  })
})

describe("Observability's file logger", () => {
  test("an unwritable log directory falls back to stderr — the boot still comes up", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "home")
    // A writable home whose `<data>/log` is a FILE. This is the case that separates the two fixes:
    // the home itself is fine, so `Global` must NOT relocate (that would orphan the user's real
    // database in a temp directory), and the logger must survive on its own.
    fsSync.mkdirSync(path.join(home, "data"), { recursive: true })
    fsSync.writeFileSync(path.join(home, "data", "log"), "not a directory")

    const { report, stderr, exitCode } = await boot(home)

    // The control: `Logger.toFile` on this exact path really does fail. This is what `Layer.orDie`
    // used to turn into a defect.
    expect(report.unguardedLogger).toBe("failed")

    // The claim: the whole `Observability.layer` builds AND emits.
    expect(exitCode).toBe(0)
    expect(report.booted).toBe(true)
    expect(report.guardedLogger).toBe("stderr")
    // …and the line really went to stderr, through the production logfmt formatter. Verifying the
    // CONTENT, not merely that something was written.
    expect(stderr).toContain('message="boot-degrade probe reached the logger"')
    expect(stderr).toContain("level=INFO")
    // ⚠️ "write", not "open": Phase 2's writer degrades on the first failing WRITE as well as on a
    // failing open, and one wording covers both. A message that only said "could not open" would be
    // a false description of a disk that filled up an hour into the run (ruling 2).
    expect(stderr).toContain("[novaclaw] WARNING: could not write the log file")

    // …and `Global` degraded IN PLACE rather than moving the instance for one bad subdirectory.
    expect(report.status.state).toBe("degraded")
    expect(report.data).toBe(path.join(home, "data"))
    if (report.status.state !== "degraded") throw new Error("unreachable")
    expect(report.status.failures.map((fault) => fault.directory)).toEqual([path.join(home, "data", "log")])
  })
})
