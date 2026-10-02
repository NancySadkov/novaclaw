import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

/**
 * 🔴 **A hard server stop must reap what a cooperative kill cannot.**
 *
 * `util/kill-tree.ts` runs only when our code runs. On Windows a server stop is `TerminateProcess`,
 * so no `exit` hook and no signal handler survives — the only thing that can still reap the tree is
 * the kernel, through a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. A *detached* descendant
 * is the shape that escapes everything else: it leaves the libuv job and its process group, so a
 * parent-only kill leaks it (measured 2026-10-03, and documented in `test/util/process.test.ts`).
 *
 * The test kills the parent with `taskkill /f` and NO `/t`, so cooperative tree-kill is not in play:
 * with `InstanceJob.adopt()` the detached grandchild is gone; without it (the control) it survives.
 * The control is the point — it proves the containment, not the kill, is what reaped it.
 */
const FIXTURE = path.join(import.meta.dir, "..", "fixture", "instance-job-tree.ts")

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists and is not ours to signal; only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Does a detached grandchild survive a parent-only hard kill? */
async function grandchildSurvivesParentHardKill(mode: "adopt" | "plain"): Promise<boolean> {
  await using tmp = await tmpdir()
  const pidFile = path.join(tmp.path, "grandchild.pid")
  const parent = Bun.spawn([process.execPath, FIXTURE, mode, pidFile], { stdio: ["ignore", "ignore", "ignore"] })

  let grandchild = 0
  for (let i = 0; i < 200 && grandchild === 0; i++) {
    grandchild = Number.parseInt(await fs.readFile(pidFile, "utf8").catch(() => ""), 10) || 0
    if (!grandchild) await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(grandchild).toBeGreaterThan(0)
  expect(alive(grandchild)).toBe(true)

  // The parent ONLY — no `/t`. Anything still alive after this was not reached cooperatively.
  Bun.spawnSync(["taskkill", "/pid", String(parent.pid), "/f"], { stdio: ["ignore", "ignore", "ignore"] })
  await parent.exited.catch(() => undefined)

  for (let i = 0; i < 200 && alive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 25))
  const survived = alive(grandchild)
  if (survived) {
    try {
      process.kill(grandchild, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
  return survived
}

describe("InstanceJob — the OS reaps what a hard stop leaves", () => {
  test("a detached grandchild dies with its adopting parent, and survives without it", async () => {
    if (process.platform !== "win32") return
    expect(await grandchildSurvivesParentHardKill("adopt")).toBe(false)
    expect(await grandchildSurvivesParentHardKill("plain")).toBe(true)
  }, 30000)
})
