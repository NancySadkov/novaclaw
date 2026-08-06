/**
 * The UPSTREAM Bun crash, recognised by signature so the gate stops charging us for it.
 *
 * Bun 1.3.14's native file watcher segfaults intermittently: the child dies with **`exit 3`** and a
 * `bun.report` URL whose frames are dominated by **`watcher.node`**, having produced **no failing
 * assertions at all**. It is not an OOM, not the wall-clock kill, and not ours — `todo.md`'s header
 * and `todo/v0.2.0-prep.md` both carry it, and there is no fix on our side.
 *
 * 🔴 **Why detect it rather than keep re-running by hand.** Measured 2026-08-06: it fired on THREE
 * consecutive `core` runs in one session, on a box checked clean between attempts (55% commit, zero
 * orphan `bun`), passing only on the fourth. Every occurrence costs a full re-run plus the human
 * question *"is this mine?"* — and that question is the expensive part, because answering it honestly
 * needs another run. Recognising it turns a five-minute attribution into a retry the runner does
 * itself.
 *
 * ⚠️ **It lives in `lib/` rather than in `test.ts` for a mundane but load-bearing reason:** `test.ts`
 * RUNS the whole suite at import, so a test importing it would execute the gate as a side effect
 * (observed: importing it fired a 0/20 run before a single assertion). Every pure, tested piece of
 * the runner belongs here for the same reason — that is what this directory is.
 */

/**
 * Did this child die of the upstream watcher segfault, and nothing else?
 *
 * ⚠️ **Scoped as narrowly as it can be, on purpose.** It requires the exit code AND the frame AND an
 * empty failure list, so it cannot swallow a real regression that happens to crash: a genuine test
 * failure reports assertions, and a different native crash names a different module. A retry that
 * could mask a real defect would be worse than the tax it removes.
 */
export function isUpstreamWatcherCrash(status: number | null, captured: string): boolean {
  if (status !== 3) return false
  if (!/watcher\.node/.test(captured)) return false
  // A crash that ALSO produced failing assertions is not this: something real broke first, and the
  // crash is a symptom rather than the story. Retrying would discard the evidence.
  return !/\(fail\)/.test(captured)
}
