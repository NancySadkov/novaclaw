import { spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { parseGuardRecord } from "./guard-record"

/**
 * The guard's own bounds, EXERCISED rather than described.
 *
 * 🔴 **The loop had no way out at all.** Measured 2026-09-03: pid 22292 started at 03:30, the last
 * typecheck ended at 19:02, and it was still polling at 21:22 — one such process per boot since
 * 2026-08-18, ending only at a reboot or by hand. `script/lib/peak-sampler.ts` had already reached
 * the conclusion this restates: a detached helper's bound has to live in the LOOP, because by
 * construction there is no caller left to reach it.
 *
 * These tests run the REAL `tsgo-guard.ps1`, not a paraphrase of it. A bound is only real if
 * something has watched it fire, and the control is the half that makes the firing mean anything: a
 * guard that exits immediately would pass every "does it exit?" assertion while guarding nothing.
 *
 * ⚠️ The subject is a uniquely-named COPY of `ping.exe`, never the live `tsgo` name. Pointing the
 * test at `tsgo` would make it race whatever else on this box is typechecking — green or red
 * depending on a neighbour, which is not a test.
 */
describe.skipIf(process.platform !== "win32")("the tsgo guard bounds itself", () => {
  const IDLE_SECONDS = 3
  const started: ChildProcess[] = []
  const dirs: string[] = []

  // ⚠️ Windows holds a lock on a RUNNING executable's file, and the subject is a copy of one living
  // in the directory being removed. Killing is asynchronous, so tearing down without waiting for the
  // exit failed the *cleanup* of a test whose assertions had all passed — a red run reporting a bug
  // that is not there. Wait for each child, then sweep.
  afterEach(async () => {
    await Promise.all(
      started.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve()
            child.on("exit", () => resolve())
            try {
              child.kill()
            } catch {
              resolve()
            }
            setTimeout(resolve, 5_000).unref?.()
          }),
      ),
    )
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is litter, never a failure of what this file tests.
      }
    }
  })

  /** A real process with a name nothing else on this machine can be wearing. */
  function startSubject(dir: string): { name: string; child: ChildProcess } {
    const name = `novaclaw-guard-subject-${process.pid}`
    const exe = join(dir, `${name}.exe`)
    copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"), exe)
    const child = spawn(exe, ["-n", "300", "127.0.0.1"], { stdio: "ignore", windowsHide: true })
    started.push(child)
    return { name, child }
  }

  function startGuard(dir: string, subject: string): { child: ChildProcess; pidFile: string; exited: Promise<void> } {
    const pidFile = join(dir, "tsgo-guard.pid")
    const shell = Bun.which("pwsh") ?? "powershell"
    const child = spawn(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dir, "..", "tsgo-guard.ps1"),
        "-LogPath",
        join(dir, "tsgo-guard.log"),
        "-ProcessNames",
        subject,
        "-IdleExitSeconds",
        String(IDLE_SECONDS),
        "-IntervalSeconds",
        "1",
        // Far above anything a copy of ping.exe can reach: this test is about the BOUNDS, and a kill
        // firing here would be the guard doing its other job, not the one under test.
        "-CeilingMB",
        "4000000",
      ],
      { stdio: "ignore", windowsHide: true },
    )
    started.push(child)
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()))
    return { child, pidFile, exited }
  }

  const until = async (predicate: () => boolean, ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return true
      await Bun.sleep(100)
    }
    return predicate()
  }

  /**
   * How long to allow for an exit that must EVENTUALLY happen.
   *
   * 🔴 **This was 20 s, and 20 s is a latency assumption wearing an assertion's clothes.** Both tests
   * passed in 1.8 s when the file was run alone and the ownership one then failed in the gate, which
   * runs this unit's whole directory in one process beside three other units on a box with ~1.9 GB
   * free. A guard tick there is `Start-Sleep 1` plus a full `Get-Process` enumeration, and that
   * stretches to seconds under load — so the run went red because the machine was busy.
   *
   * ⚠️ Generous does NOT mean toothless, and that distinction is the whole reason this is safe to
   * raise: the failure being guarded against is a loop with no way out, which never exits at any
   * budget. The poison A/B is the evidence — removing the bound fails this file whether the wait is
   * 20 s or 200 s.
   */
  const EXIT_BUDGET_MS = 90_000

  /** Resolves true if the guard exited inside the window, false if it was still running. */
  const exitedWithin = async (exited: Promise<void>, ms: number) =>
    Promise.race([exited.then(() => true), Bun.sleep(ms).then(() => false)])

  /** Wait for an exit and SAY how long it took, so a red distinguishes "slow" from "never". */
  const exitedEventually = async (exited: Promise<void>) => {
    const started = Date.now()
    const ok = await exitedWithin(exited, EXIT_BUDGET_MS)
    return { ok, ms: Date.now() - started }
  }

  test("it stays up while its subject lives, then exits once the subject is gone", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "novaclaw-tsgo-guard-"))
    dirs.push(dir)
    const subject = startSubject(dir)
    const guard = startGuard(dir, subject.name)

    expect(await until(() => existsSync(guard.pidFile), 10_000)).toBe(true)

    // THE CONTROL. Well past the idle window with the subject alive: a guard that exits on a timer,
    // or one that cannot see its subject, dies here and the test below stops proving anything.
    expect(await exitedWithin(guard.exited, IDLE_SECONDS * 1000 * 2.5)).toBe(false)

    // The heartbeat moves while it runs — this is what tells a live guard from a leftover record.
    const first = parseGuardRecord(readFileSync(guard.pidFile, "utf8"))
    expect(first?.pid).toBeGreaterThan(0)
    expect(
      await until(() => (parseGuardRecord(readFileSync(guard.pidFile, "utf8"))?.beatMs ?? 0) > first!.beatMs, 5_000),
    ).toBe(true)

    // THE BOUND. The subject finishes; the guard has nothing left to guard.
    subject.child.kill()
    const gone = await exitedEventually(guard.exited)
    expect(gone.ok, `the guard was still running ${gone.ms} ms after its subject died`).toBe(true)
    // And it takes its record with it, so the next wrapper run does not read a corpse as a guard.
    expect(existsSync(guard.pidFile)).toBe(false)
  }, 150_000)

  test("it exits when the pid file stops naming it, and leaves the successor's record alone", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "novaclaw-tsgo-guard-"))
    dirs.push(dir)
    const subject = startSubject(dir)
    const guard = startGuard(dir, subject.name)

    expect(await until(() => existsSync(guard.pidFile), 10_000)).toBe(true)

    // Someone else took the post — a fresh guard, or a human reaping this one by hand. The subject is
    // still alive, so idleness cannot be what ends it: only ownership can.
    const successor = `999999 ${Date.now()}`
    // A heartbeat holds a short exclusive write handle. Taking ownership retries that lock,
    // then must remain effective even when it lands during the old guard's process enumeration.
    expect(
      await until(() => {
        try {
          writeFileSync(guard.pidFile, successor)
          return true
        } catch {
          return false
        }
      }, 5_000),
    ).toBe(true)

    const gone = await exitedEventually(guard.exited)
    expect(gone.ok, `the guard was still running ${gone.ms} ms after losing the pid file`).toBe(true)
    expect(readFileSync(guard.pidFile, "utf8").trim()).toBe(successor)
  }, 150_000)
})
