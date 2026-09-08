// ⚠️ **Closing a scope around a child process must never wait on the child's PIPES.**
//
// Node fires `'exit'` when the child terminates and `'close'` only once every stdio stream has also
// closed — and a stream stays open while ANYONE holds the write end, including a grandchild that
// inherited it. So a command whose last act is to leave a background process behind (`npm run dev`,
// a watcher, a spawned server — the exact commands `bash-jobs` exists to host) fires `'exit'`
// immediately and `'close'` only when that grandchild dies, which for a daemon is never.
//
// `cross-spawn-spawner.ts`'s `acquireRelease` finalizer used to `Deferred.await` the `'close'`
// deferred with NO bound, so closing such a scope blocked for as long as the grandchild lived. The
// user-facing shape was `BashJobs.stop` — the agent's "stop this job" control — never returning,
// wedging the session's turn behind it, with no timeout anywhere above it to break the deadlock.
//
// ⚠️ **This test must not consume the child's output**, and that is the whole reason it is a
// separate file rather than another case in `effect/cross-spawn-spawner.test.ts`. A stream consumer's
// own interruption closes the read end, which makes `'close'` fire and hides the bug completely —
// measured while building this check: the same scenario driven through `BashJobs.stop` tore down in
// 194 ms **with the bug still present**, because the interrupted `Stream.runForEach` had already
// released the pipe. A green run of a test that cannot fail is worse than no test.
//
// Negative control (2026-07-31, win32), run per assertion so neither rides on the other: reverting
// ONLY the release finalizer's wait to the `'close'` deferred failed case 1 at **3287 ms**; reverting
// ONLY `handle.kill`'s failed case 2 at **3287 ms** while case 1 stayed green. With the fix both
// measure ~0.4 s. Raise `HOLD_MS` and the gap widens with it — that is what "unbounded" meant, and
// why no timeout VALUE would have been the right fix.
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { KillTree } from "@novaclaw/core/util/kill-tree"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const fx = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

/** How long the grandchild holds the pipe. It self-exits, and the test reaps it by tree regardless. */
const HOLD_MS = 4_000
/** Teardown budget. The honest cost is a tree-kill (~0.2–0.5 s here); the bug cost the whole HOLD_MS. */
const TEARDOWN_BUDGET_MS = 2_000

/**
 * A command that exits IMMEDIATELY while a detached grandchild keeps its stdout/stderr open.
 *
 * `node` rather than `bun` for both processes on purpose: measured 2026-07-31, `Bun.spawn`'s
 * `"inherit"` does not hand the parent's overlapped pipe to the grandchild on Windows, so a bun
 * holder releases the pipe at once and reproduces nothing. The grandchild writes its pid out before
 * detaching so the test can reap it — it survives the tree-kill by construction (its parent is
 * already gone, so no ppid walk from the child can reach it), and an unaccounted survivor is exactly
 * what AGENTS.md pitfall #8 forbids.
 */
const holder = (pidFile: string) => `
const cp = require("node:child_process")
const fs = require("node:fs")
const gc = cp.spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), ${HOLD_MS})"], {
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
})
fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid))
gc.unref()
process.exit(0)
`

describe("spawner teardown is bounded by process exit, not by pipe close", () => {
  // `fx.live`, never `fx.effect`: the whole assertion is about WALL CLOCK, and `fx.effect` runs under
  // a TestClock where the sleep below never advances and the test simply hangs.
  fx.live(
    "a scope closes promptly even when a grandchild still holds the child's stdout",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const pidFile = path.join(tmp.path, "grandchild.pid")

      let scopeCloseStartedAt = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ChildProcess.make("node", ["-e", holder(pidFile)], { stdin: "ignore" })
          // Long enough for the child to spawn its grandchild and exit — i.e. for `'exit'` to have
          // fired and `'close'` to be provably outstanding. Deliberately no stream consumer: see the
          // header.
          yield* Effect.sleep("800 millis")
          scopeCloseStartedAt = Date.now()
        }),
      )
      const teardownMs = Date.now() - scopeCloseStartedAt

      // The grandchild must have actually taken the pipe, or the scenario never existed and a fast
      // teardown proves nothing. This is the check that stops the test rotting into a tautology.
      // Reap BEFORE asserting: a failed expectation must not be able to strand the grandchild, and
      // `killTree` ignores a non-positive/NaN target, so it is safe to call before the check below.
      const grandchild = Number((yield* Effect.promise(() => fs.readFile(pidFile, "utf8"))).trim())
      yield* Effect.promise(() => KillTree.killTree(grandchild))
      expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true)

      expect(teardownMs).toBeLessThan(TEARDOWN_BUDGET_MS)
    }),
    20_000,
  )

  // The same defect on the PUBLIC api. `handle.kill` is what a caller reaches for when it wants the
  // child gone, and it awaited the same `'close'` deferred — so it too could never return. Covered
  // separately because the scope-close path above would still pass if only `kill` regressed.
  fx.live(
    "handle.kill resolves once the process is gone, not once its pipes are",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const pidFile = path.join(tmp.path, "grandchild.pid")

      const killMs = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make("node", ["-e", holder(pidFile)], { stdin: "ignore" })
          yield* Effect.sleep("800 millis")
          const started = Date.now()
          yield* handle.kill()
          return Date.now() - started
        }),
      )

      // Reap BEFORE asserting: a failed expectation must not be able to strand the grandchild, and
      // `killTree` ignores a non-positive/NaN target, so it is safe to call before the check below.
      const grandchild = Number((yield* Effect.promise(() => fs.readFile(pidFile, "utf8"))).trim())
      yield* Effect.promise(() => KillTree.killTree(grandchild))
      expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true)

      expect(killMs).toBeLessThan(TEARDOWN_BUDGET_MS)
    }),
    20_000,
  )
})
