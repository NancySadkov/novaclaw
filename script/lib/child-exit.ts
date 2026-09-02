/**
 * Wait for a spawned child to finish — WITHOUT waiting on a process we did not spawn.
 *
 * ─── 🔴 the hang this exists to prevent, measured 2026-09-02 ────────────────────────────────────
 *
 * `script/test.ts` moved from `spawnSync` to async `spawn` so phase 2 could run a pool. The obvious
 * translation awaits `close`, and `close` is the right event for the reason the runner's header
 * gives: it fires once the stdio streams are drained, so nothing is captured half-way.
 *
 * **It also never fires when a grandchild outlives the child.** `bun test` is a PARENT+CHILD pair
 * sharing one command line (AGENTS.md → Known pitfalls #8), and `reapOrphans` in `test.ts` exists
 * precisely because a signal aimed at the parent leaves the child alive. That survivor inherited the
 * pipe **write ends**, so the pipes never reach EOF, so `close` never arrives — and `reapOrphans`,
 * which runs after the await, never gets to clean up the thing that is holding it.
 *
 * Observed end to end: `core`'s 600 s wall-clock backstop fired on schedule and killed the direct
 * child (which really did die — its PID was gone). The runner then sat for **36 minutes** on a
 * grandchild holding **14.6 GB** and 0 % CPU with its commit charge frozen to the byte, i.e. the
 * documented signature of HUNG rather than slow. A hang backstop that hangs is worse than none: it
 * is the one failure `test.ts` is built to make impossible, reintroduced underneath it.
 *
 * ⚠️ **The timeout is not the only way in.** Any unit whose tests leak a process that inherited
 * stdio wedges the gate the same way on a perfectly green run. That is why the fix is here, on the
 * normal path, rather than in the timeout handler.
 *
 * ─── what it does instead ───────────────────────────────────────────────────────────────────────
 *
 * `exit` is the fact we actually want — *the process we spawned is gone*. `close` is a nicety on top
 * of it: *and its output is complete*. So this waits for `close`, but once `exit` has fired it gives
 * the pipes a bounded grace period and then answers anyway, reporting `drained: false` so the caller
 * can say the output may be short rather than presenting a truncated log as a whole one.
 */
import type { ChildProcess } from "node:child_process"

/**
 * How long to let the pipes drain after the child itself is gone.
 *
 * Generous for its real job — a normal child's `close` follows `exit` within milliseconds, because
 * by then the only writer has already exited — and short enough that a leaked grandchild costs two
 * seconds instead of forever. It is a DRAIN window, never a hang backstop: the wall clock is that.
 */
export const STDIO_DRAIN_GRACE_MS = 2_000

export interface ChildOutcome {
  /** The child's exit code, or `null` when it died of a signal or never started. */
  readonly status: number | null
  /**
   * The stdio streams closed on their own, so the captured output is COMPLETE.
   *
   * ⚠️ `false` means something still holds the write end — a leaked grandchild — and the capture is
   * whatever had arrived by then. Never report that as a whole log.
   */
  readonly drained: boolean
  /** A spawn error's code (`ENOENT`, …) when the child never ran at all. */
  readonly errno?: string
}

/**
 * Settle when the child is gone, whatever its leftovers are doing.
 *
 * `error` is folded in here rather than handled by the caller because on some platforms a failed
 * spawn produces no `close` at all, and a caller awaiting only `close` would hang on a typo in a
 * command name — the same defect as the grandchild, entered from the other side.
 */
export function awaitChildExit(child: ChildProcess, graceMs: number = STDIO_DRAIN_GRACE_MS): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: ChildOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    child.once("error", (error) =>
      settle({ status: null, drained: true, errno: (error as NodeJS.ErrnoException).code ?? error.message }),
    )
    child.once("close", (code) => settle({ status: code, drained: true }))
    child.once("exit", (code) => {
      const timer = setTimeout(() => settle({ status: code, drained: false }), graceMs)
      // Nothing may be kept alive by the grace timer itself: on the happy path `close` has already
      // settled this promise and the timer is pure overhang, which would otherwise delay the
      // runner's own exit by the grace period on the very last unit of a run.
      timer.unref?.()
    })
  })
}
