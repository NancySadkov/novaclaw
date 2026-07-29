import fsSync from "fs"
import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"

/**
 * **Every fixture temp directory in this package, under ONE root named for this process.**
 *
 * ⚠️ Why the root exists at all. A `tmpdir()` disposes itself, so in a green run nothing leaks —
 * but a wall-clock kill, a crash, or an interrupted suite skips the disposal, and there was no
 * second mechanism. Measured 2026-07-29: **24** abandoned `novaclaw-core-test-*` directories in
 * `%TEMP%`, dated 07-14 → 07-28, one per killed run, and nothing would ever have removed them.
 *
 * ⚠️ **`bun test` does NOT run `process.on("exit")` handlers.** Measured 2026-07-28 on bun 1.3.14
 * (see `fixture/git.ts`, which learned this the same way): a handler registered from a passing
 * test never fired. So teardown cannot be an exit hook, and none is registered here — a cleanup
 * that silently never runs is worse than no cleanup, because it stops anyone looking.
 *
 * The mechanism is `fixture/git.ts`'s, same shape: the root is named by **PID**, and every run
 * first reaps the roots whose owning process is gone. That bounds `%TEMP%` at one directory per
 * LIVE test process and heals whatever an earlier crash left behind, with no timer, no hook and no
 * shared state (AGENTS.md pitfall #8 — nothing you start goes unaccounted for).
 */
const ROOT_PREFIX = "novaclaw-core-test-pid"

let root: string | undefined

/**
 * ⚠️ The `pid` infix is load-bearing, not decoration. `fs.mkdtemp` appends exactly SIX characters,
 * so a directory this reap would consider — `novaclaw-core-test-pid<digits>` — can never be one
 * mkdtemp produced. Without it the prefix would also match `novaclaw-core-test-<6 random chars>`
 * (the shape this fixture used to create), and an all-numeric six-character name would parse as a
 * PID: a concurrent run's live directory deleted out from under it. Trading a leak for a flaky
 * suite is a bad trade, so the two namespaces are made disjoint instead.
 *
 * ⚠️ Two independent arithmetic facts hold that disjointness — mkdtemp's suffix length, and this
 * reap parsing everything after `-pid` as an integer — and they live in different places. It used
 * to rest on a third: `test/effect/cross-spawn-spawner.test.ts` had its own inline `mkdtemp` with
 * the same prefix and no reap, which this paragraph cited as a live second producer. It was
 * converted on 2026-07-29, and the single-producer property is now ENFORCED rather than described:
 * `test/tmpdir-namespace.test.ts` fails if any file but this one names the prefix in a literal.
 */
function testRoot(): string {
  if (root !== undefined) return root
  reapAbandonedRoots()
  const directory = path.join(osTmpdir(), `${ROOT_PREFIX}${process.pid}`)
  fsSync.mkdirSync(directory, { recursive: true })
  root = directory
  return directory
}

/**
 * Delete roots whose owning process is gone.
 *
 * Keyed on PID, never on age: `script/test.ts` runs units in their own processes, so an age-based
 * sweep would eventually delete a CONCURRENT run's directories. `process.kill(pid, 0)` is the
 * liveness probe (no throw for a live pid, `ESRCH` for a dead one; `EPERM` means alive under
 * another account, so leave it alone). A recycled PID just means one stale root survives longer.
 *
 * Exported for the reason `git.ts`'s equivalent should be: it is the ONLY teardown mechanism, so it
 * has to be exercisable directly rather than only as a side effect of the first `tmpdir()` call.
 */
export function reapAbandonedRoots(): void {
  let entries: string[]
  try {
    entries = fsSync.readdirSync(osTmpdir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(ROOT_PREFIX)) continue
    const pid = Number(entry.slice(ROOT_PREFIX.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // still running — not ours to delete
    } catch (error) {
      // ESRCH means gone. EPERM means alive under another account: leave it alone.
      if ((error as { code?: string } | undefined)?.code === "EPERM") continue
    }
    try {
      fsSync.rmSync(path.join(osTmpdir(), entry), { recursive: true, force: true })
    } catch {
      // Another process may be reaping the same root; losing the race is fine.
    }
  }
}

export const tmpdir = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(testRoot(), "t")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await remove(dir)
    },
  }
}

async function remove(dir: string, retries = 30): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY")
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
