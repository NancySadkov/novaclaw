import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The crash matrix, as a LEDGER over the recovery suites.
 *
 * `todo/session-recovery.md` asks for *"a bounded Windows/Linux crash matrix: before dispatch,
 * during execution, after side effect, during result persistence, worker crash, host crash,
 * cancellation, and restart"*. Twenty-one recovery tests existed and covered most of that — but
 * spread across four files under names chosen for what each asserts, so **nobody could say which
 * fault points were covered**. A matrix that cannot be read is not a matrix, and "we have recovery
 * tests" is not the same claim as "every fault point has one".
 *
 * This file is the reading. Each point names the tests that cover it; a point with none is a GAP,
 * pinned below by name.
 *
 * ⚠️ **What this ledger does and does not prove.** It proves the mapping is stated and that every
 * named test still exists — so deleting or renaming a covering test breaks the matrix instead of
 * silently emptying a row. It does NOT prove those tests inject the fault well; that is the job of
 * the tests themselves. Its value is that a gap becomes visible, which is the thing the roadmap item
 * actually asked for.
 */

const TEST_DIR = import.meta.dir
const suite = (name: string) => readFileSync(join(TEST_DIR, `${name}.test.ts`), "utf8")

interface Point {
  readonly id: string
  /** What fault is injected, in the roadmap's own vocabulary. */
  readonly fault: string
  /** `${suite}` → the exact test names that cover it. Empty = a pinned gap. */
  readonly covered: ReadonlyArray<readonly [string, string]>
  /** Present only on a gap: why it is not covered, and what a covering test would have to do. */
  readonly gap?: string
}

const MATRIX: readonly Point[] = [
  {
    id: "before-dispatch",
    fault: "the process dies after a tool is chosen but before the adapter is called",
    covered: [["session-recovery-decision", "retries boundaries before side effects"]],
  },
  {
    id: "during-execution",
    fault: "the process dies while an adapter is running",
    covered: [
      ["session-execution-attempt", "classifies live worker loss and opens the circuit breaker without replaying tools"],
      ["session-runner-recovery", "durably fails local tools left running by a prior process before continuing"],
    ],
  },
  {
    id: "after-side-effect",
    fault: "the adapter completed its external effect, then the process died before recording it",
    covered: [
      ["session-execution-attempt", "pauses an orphaned unsettled tool instead of replaying it"],
      ["session-recovery-decision", "never automatically replays an unsettled tool"],
    ],
  },
  {
    id: "during-result-persistence",
    fault: "the process dies midway through writing the tool result",
    covered: [],
    gap:
      "Nothing injects a fault BETWEEN the effect completing and its result being durable. " +
      "`atomically replaces ownership and fences stale settlement` is the nearest, and it tests " +
      "the fence rather than a torn write. A covering test must leave the store in the state a " +
      "half-written result produces and assert recovery reaches one durable terminal state — not " +
      "that it resumes, which for a non-idempotent effect would be the wrong answer.",
  },
  {
    id: "worker-crash",
    fault: "the execution worker dies while the host survives",
    covered: [
      ["session-execution-attempt", "classifies live worker loss and opens the circuit breaker without replaying tools"],
      ["session-runner-recovery", "durably fails hosted tools left running by a prior process before continuing inline"],
    ],
  },
  {
    id: "host-crash",
    fault: "the whole process dies and a later process finds the leftovers",
    covered: [
      ["session-runner-recovery", "durably fails pending tool input left by a prior process before continuing"],
      ["session-execution-attempt", "marks an expired heartbeat interrupted and resets the failure budget after success"],
    ],
  },
  {
    id: "cancellation",
    fault: "the user stops a turn while a tool is in flight",
    covered: [],
    gap:
      "`marks an expired heartbeat interrupted` covers a heartbeat EXPIRING, which is not the same " +
      "event: a user-initiated stop is prompt, attributable and expected, and must not open the " +
      "failure circuit breaker the way a loss does. Nothing asserts that difference, so a stop " +
      "during a non-idempotent tool has no pinned terminal state.",
  },
  {
    id: "restart",
    fault: "a new process starts over a session the previous one left mid-flight",
    covered: [
      ["session-boot-recovery", "input already promoted by the previous process is not run twice"],
      ["session-boot-recovery", "queued input wakes; a leftover steer does not"],
    ],
  },
]

/**
 * ⚠️ SHRINK-ONLY. These two are the honest state of the matrix, not an allowance. Adding an id here
 * is how a fault point stops being covered, which is exactly the move this ledger exists to catch —
 * so the assertion is equality, not `toContain`.
 */
const PINNED_GAPS = ["cancellation", "during-result-persistence"] as const

describe("the crash matrix is readable", () => {
  test("every covering test named here still exists", () => {
    const missing: string[] = []
    for (const point of MATRIX) {
      for (const [file, name] of point.covered) {
        if (!suite(file).includes(name)) missing.push(`${point.id}: ${file} has no "${name}"`)
      }
    }
    // A renamed or deleted test empties a matrix row silently; this is the only thing standing
    // between "we have recovery tests" and a row that quietly became a claim about nothing.
    expect(missing).toEqual([])
  })

  test("the uncovered fault points are exactly the two pinned ones", () => {
    const gaps = MATRIX.filter((point) => point.covered.length === 0).map((point) => point.id)
    expect(gaps.toSorted()).toEqual([...PINNED_GAPS].toSorted())
  })

  test("every pinned gap says what a covering test would have to do", () => {
    // A gap recorded without that is indistinguishable from an oversight a year later.
    for (const point of MATRIX.filter((p) => p.covered.length === 0)) {
      expect(point.gap, `${point.id} is a gap with no explanation`).toBeTruthy()
      expect(point.gap!.length, `${point.id}'s explanation is too thin to act on`).toBeGreaterThan(80)
    }
  })

  test("the matrix covers the eight fault points the roadmap names", () => {
    expect(MATRIX.map((point) => point.id)).toEqual([
      "before-dispatch",
      "during-execution",
      "after-side-effect",
      "during-result-persistence",
      "worker-crash",
      "host-crash",
      "cancellation",
      "restart",
    ])
  })
})
