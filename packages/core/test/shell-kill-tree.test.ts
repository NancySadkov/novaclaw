/**
 * `Shell.killTree` — the ONE tree-kill in the codebase (B8, v0.2.0-prep wave 1).
 *
 * ⚠️ Why this file spawns real processes instead of asserting on argv. The defect it guards is that a
 * kill reaches the root and orphans everything below it, and orphaned children are a machine-killer
 * here: on 2026-07-20 accumulated orphans pinned commit charge at 99.9% of a 68 GB ceiling and hard-
 * crashed the laptop (AGENTS.md → Known pitfalls #8). "Did we build the right argv" cannot see that.
 * Only "is the grandchild gone" can — so every kill test below asserts on the GRANDCHILD.
 *
 * The `leaves the grandchild alive` test is the NEGATIVE CONTROL, kept permanently: it performs the
 * old root-only kill and asserts the leak still happens. If the platform ever started killing
 * descendants for free, that test would fail and tell us these tests had stopped discriminating.
 *
 * Run unit: `core`, in the FAST tier of `bun run test` (script/test.ts — core is not `fullOnly`), so
 * this runs on every day-to-day suite invocation rather than only under `--full`.
 *
 * Nothing here can leak: every tree is registered before it is started and tree-killed in afterEach,
 * and the fixture itself self-destructs after 30 s.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Shell } from "@novaclaw/core/shell"

const FIXTURE = path.join(import.meta.dir, "fixture/kill-tree-tree.ts")

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** EPERM means "exists but not ours" — still alive. Anything else (ESRCH) means gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const stop = Date.now() + timeoutMs
  while (Date.now() < stop) {
    if (check()) return true
    await sleep(50)
  }
  return check()
}

type Tree = { handle: ChildProcess; parent: number; grandchild: number; dir: string }

const started: Tree[] = []

/**
 * Start a parent that spawns one grandchild, and wait until BOTH pids are known and running.
 *
 * `detached` mirrors the two real shapes: the jh / cross-spawn runners spawn detached (the child
 * leads its own POSIX process group), while the MCP SDK's StdioClientTransport does NOT — its
 * children share our group, which is precisely why a group-only kill is not enough.
 */
async function startTree(detached: boolean): Promise<Tree> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kill-tree-"))
  const out = path.join(dir, "pids.json")
  const handle = spawn(process.execPath, [FIXTURE, out], { stdio: "ignore", detached })
  const tree: Tree = { handle, parent: handle.pid ?? -1, grandchild: -1, dir }
  started.push(tree)

  const stop = Date.now() + 10_000
  while (Date.now() < stop) {
    const text = await fs.readFile(out, "utf8").catch(() => "")
    if (text) {
      const pids = JSON.parse(text) as { parent?: number; grandchild?: number | null }
      if (typeof pids.parent === "number" && typeof pids.grandchild === "number") {
        tree.grandchild = pids.grandchild
        expect(pids.parent).toBe(tree.parent)
        break
      }
    }
    await sleep(50)
  }

  expect(tree.parent).toBeGreaterThan(0)
  expect(tree.grandchild).toBeGreaterThan(0)
  expect(alive(tree.parent)).toBe(true)
  expect(alive(tree.grandchild)).toBe(true)
  return tree
}

afterEach(async () => {
  // The no-zombies rule, mechanised. Kill by TREE, then the grandchild by pid as a belt-and-braces
  // sweep for the negative-control test, which deliberately leaves one running.
  for (const tree of started.splice(0)) {
    await Shell.killTree(tree.handle)
    await Shell.killTree(tree.grandchild)
    await fs.rm(tree.dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("Shell.killTree", () => {
  test("kills the grandchild too, given a PID (the MCP stdio shape)", async () => {
    const tree = await startTree(false)

    await Shell.killTree(tree.parent)

    expect(await until(() => !alive(tree.parent), 5_000)).toBe(true)
    // THE assertion. A root-only kill passes everything above this line and fails here.
    expect(await until(() => !alive(tree.grandchild), 5_000)).toBe(true)
  })

  test("kills the grandchild too, given a ChildProcess (the detached runner shape)", async () => {
    const tree = await startTree(true)

    await Shell.killTree(tree.handle)

    expect(await until(() => !alive(tree.parent), 5_000)).toBe(true)
    expect(await until(() => !alive(tree.grandchild), 5_000)).toBe(true)
  })

  /**
   * NEGATIVE CONTROL — proves the two tests above can fail.
   *
   * `handle.kill()` is what the MCP SDK's `client.close()` ultimately does, and what the old MCP
   * teardown did on Windows (its `descendants()` helper opened with `if (win32) return []`, so the
   * finalizer signalled nothing at all). The grandchild must survive it.
   *
   * ⚠️ This test is the reason the fixture detaches its grandchild. First written without that, this
   * assertion FAILED on Windows — bun's job object had already killed the grandchild along with its
   * parent, meaning the two tests above were passing for a reason that had nothing to do with
   * killTree. A negative control that cannot fail is not a control; this one caught a real hole in
   * its own suite.
   */
  test("root-only kill leaves the grandchild alive — the leak killTree exists to close", async () => {
    const tree = await startTree(false)

    tree.handle.kill()

    expect(await until(() => !alive(tree.parent), 5_000)).toBe(true)
    await sleep(500)
    expect(alive(tree.grandchild)).toBe(true)

    // ...and killTree still reaps it once the root is already gone.
    await Shell.killTree(tree.grandchild)
    expect(await until(() => !alive(tree.grandchild), 5_000)).toBe(true)
  })

  test("does nothing when there is no pid to kill", async () => {
    // ⚠️ `process.kill(-1, …)` signals EVERY process the user owns. A non-positive pid must never
    // reach the kill path, and neither must an absent one.
    await Shell.killTree(undefined)
    await Shell.killTree(null)
    await Shell.killTree(0)
    await Shell.killTree(-1)
    await Shell.killTree({ pid: undefined } as unknown as ChildProcess)
    expect(alive(process.pid)).toBe(true)
  })

  test("honours the exited() short-circuit so a reused pid is never signalled", async () => {
    const tree = await startTree(false)

    await Shell.killTree(tree.parent, { exited: () => true })
    await sleep(300)

    expect(alive(tree.parent)).toBe(true)
    expect(alive(tree.grandchild)).toBe(true)
  })
})

/**
 * The SYNC twin. It exists for contexts that cannot await — a `process.on("exit")` hook, an
 * `Effect.sync` finalizer, a signal handler that calls `process.exit` on the next line — and it is
 * live in four teardown paths (`pty.ts`, `cli/cmd/serve.ts`, `app/scripts/dev-with-backend.ts` and
 * the cross-spawn spawner's interrupted-acquire path). An async kill fired from any of those is not
 * guaranteed to outlive the process that fired it, which is the whole point: it would READ as a kill
 * and reap nothing. So it gets the same grandchild assertion as the async one.
 */
describe("Shell.killTreeSync", () => {
  test("kills the grandchild too (the process.on('exit') shape)", async () => {
    const tree = await startTree(false)

    Shell.killTreeSync(tree.parent)

    expect(await until(() => !alive(tree.parent), 5_000)).toBe(true)
    // THE assertion, same as the async leg: a root-only kill passes everything above and fails here.
    expect(await until(() => !alive(tree.grandchild), 5_000)).toBe(true)
  })

  test("does nothing when there is no pid to kill", async () => {
    // ⚠️ Same landmine as the async leg, and worse here because nothing awaits the result:
    // `process.kill(-1, …)` signals EVERY process the user owns.
    Shell.killTreeSync(undefined)
    Shell.killTreeSync(null)
    Shell.killTreeSync(0)
    Shell.killTreeSync(-1)
    expect(alive(process.pid)).toBe(true)
  })

  test("honours the exited() short-circuit so a reused pid is never signalled", async () => {
    const tree = await startTree(false)

    Shell.killTreeSync(tree.parent, { exited: () => true })
    await sleep(300)

    expect(alive(tree.parent)).toBe(true)
    expect(alive(tree.grandchild)).toBe(true)
  })
})

describe("Shell.descendantsOf", () => {
  // The POSIX leg snapshots `pid -> ppid` (from /proc on Linux, one `ps` call elsewhere) and walks
  // it here. The snapshot source is platform-specific and is NOT exercised on Windows; this walk is
  // pure and is exercised everywhere.
  const map = (pairs: [number, number][]) => new Map<number, number>(pairs)

  test("returns every descendant, deepest first", () => {
    // 10 → 20 → 30, and 10 → 21. 99 is unrelated.
    const parents = map([
      [20, 10],
      [30, 20],
      [21, 10],
      [99, 1],
    ])
    const result = Shell.descendantsOf(10, parents)
    expect([...result].sort((a, b) => a - b)).toEqual([20, 21, 30])
    expect(result.indexOf(30)).toBeLessThan(result.indexOf(20))
    expect(result).not.toContain(99)
  })

  test("never includes the root, and returns nothing for a leaf", () => {
    expect(Shell.descendantsOf(10, map([[10, 1]]))).toEqual([])
    expect(Shell.descendantsOf(10, map([]))).toEqual([])
  })

  test("terminates on a cyclic snapshot", () => {
    // A racing/corrupt snapshot must not spin the teardown path forever.
    const result = Shell.descendantsOf(
      10,
      map([
        [20, 10],
        [10, 20],
        [30, 20],
      ]),
    )
    expect([...result].sort((a, b) => a - b)).toEqual([20, 30])
  })
})
