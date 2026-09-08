import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The crash matrix, as a LEDGER over the recovery suites.
 *
 * `` asks for *"a bounded Windows/Linux crash matrix: before dispatch,
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
      [
        "session-execution-attempt",
        "classifies live worker loss and opens the circuit breaker without replaying tools",
      ],
      ["session-runner-recovery", "durably fails local tools left running by a prior process before continuing"],
    ],
  },
  {
    id: "after-side-effect",
    fault: "the adapter completed its external effect, then the process died before recording it",
    covered: [
      ["session-execution-attempt", "resumes an orphaned unsettled tool through inspection instead of replaying it"],
      ["session-recovery-decision", "automatically inspects after an unsettled tool without replaying it"],
    ],
  },
  {
    id: "during-result-persistence",
    fault: "the process dies midway through writing the tool result",
    covered: [
      ["session-recovery-decision", "a crash after the result is durable continues instead of replaying the effect"],
      ["session-recovery-decision", "the tool result is published BEFORE the checkpoint that authorises continuing"],
    ],
  },
  {
    id: "worker-crash",
    fault: "the execution worker dies while the host survives",
    covered: [
      [
        "session-execution-attempt",
        "classifies live worker loss and opens the circuit breaker without replaying tools",
      ],
      [
        "session-runner-recovery",
        "durably fails hosted tools left running by a prior process before continuing inline",
      ],
    ],
  },
  {
    id: "host-crash",
    fault: "the whole process dies and a later process finds the leftovers",
    covered: [
      ["session-runner-recovery", "durably fails pending tool input left by a prior process before continuing"],
      [
        "session-execution-attempt",
        "marks an expired heartbeat interrupted and resets the failure budget after success",
      ],
    ],
  },
  {
    id: "cancellation",
    fault: "the user stops a turn while a tool is in flight",
    covered: [
      ["session-execution-attempt", "a user stop mid-tool settles interrupted WITHOUT spending the failure budget"],
    ],
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
 * The INPUT half of the same guarantee.
 *
 * `` asks for a durable terminal projection for *every admitted input* as
 * well as every tool-bearing turn — *"a crash must not ... strand the input"*. `session_input`
 * carries that projection as `admitted_seq` (durable the moment it is accepted) and `promoted_seq`
 * (set when it enters a turn), so an input is admitted-not-promoted or promoted, and a crash can
 * land on either side.
 *
 * The coverage was already there and, like the tool half, unreadable — spread between
 * `session-prompt` (admission) and `session-boot-recovery` (what a later process does with what it
 * finds). This maps it. No gaps: an input's fault points are cheaper to cover than a tool's,
 * because admission is a single atomic insert and nothing external happens until promotion.
 */
const INPUT_MATRIX: readonly Point[] = [
  {
    id: "admission-atomicity",
    fault: "the process dies while accepting a prompt",
    covered: [["session-prompt", "durably admits one user message before transcript promotion"]],
  },
  {
    id: "duplicate-admission",
    fault: "the client resends the same prompt after a crash it could not observe",
    covered: [
      ["session-prompt", "returns the original recorded message when the ID is retried"],
      ["session-prompt", "returns one recorded message to concurrent exact retries"],
    ],
  },
  {
    id: "conflicting-admission",
    fault: "the same id is reused for DIFFERENT content — a bug, not a retry, and must not be merged",
    covered: [
      ["session-prompt", "rejects reuse of one ID with a different prompt"],
      ["session-prompt", "rejects reuse of one ID with a different delivery mode"],
    ],
  },
  {
    id: "admitted-not-promoted",
    fault: "the process dies after admitting an input but before it enters a turn",
    covered: [["session-boot-recovery", "queued input wakes; a leftover steer does not"]],
  },
  {
    id: "promoted-not-drained",
    fault: "the process dies after promoting an input but before the turn runs",
    covered: [["session-boot-recovery", "input already promoted by the previous process is not run twice"]],
  },
  {
    id: "leftover-steer",
    fault: "a steer outlives the turn it was meant for",
    covered: [["session-boot-recovery", "queued input wakes; a leftover steer does not"]],
  },
  {
    id: "operator-control",
    fault: "a later process finds a session someone else is driving",
    covered: [["session-boot-recovery", "a session under operator control is left alone until control comes back"]],
  },
  {
    id: "unreadable-config-at-boot",
    fault: "recovery itself cannot read the config it needs",
    covered: [
      ["session-boot-recovery", "an unreadable config FAILS OPEN — the prompt is resumed, not silently dropped"],
    ],
  },
]

/**
 * ⚠️ SHRINK-ONLY, and now EMPTY — every fault point the roadmap names has a covering test.
 *
 * Both original gaps were filled by writing the missing tests, and both were worth writing:
 * `cancellation` exposed a real defect (a user stop spent the failure budget, so three
 * cancellations of a healthy session armed the circuit breaker), and `during-result-persistence`
 * turned out to rest on a source ORDERING no behavioural test could see.
 *
 * Adding an id back here is how a fault point stops being covered — which is the move this ledger
 * exists to catch, so the assertion is equality, not `toContain`.
 */
const PINNED_GAPS: readonly string[] = []

describe("the crash matrix is readable", () => {
  test("every covering test named here still exists", () => {
    const missing: string[] = []
    for (const point of [...MATRIX, ...INPUT_MATRIX]) {
      for (const [file, name] of point.covered) {
        if (!suite(file).includes(name)) missing.push(`${point.id}: ${file} has no "${name}"`)
      }
    }
    // A renamed or deleted test empties a matrix row silently; this is the only thing standing
    // between "we have recovery tests" and a row that quietly became a claim about nothing.
    expect(missing).toEqual([])
  })

  test("the uncovered fault points are exactly the two pinned ones", () => {
    const gaps = [...MATRIX, ...INPUT_MATRIX].filter((point) => point.covered.length === 0).map((point) => point.id)
    expect(gaps.toSorted()).toEqual([...PINNED_GAPS].toSorted())
  })

  test("every pinned gap says what a covering test would have to do", () => {
    // A gap recorded without that is indistinguishable from an oversight a year later.
    for (const point of [...MATRIX, ...INPUT_MATRIX].filter((p) => p.covered.length === 0)) {
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

  test("the input matrix covers admission through promotion", () => {
    expect(INPUT_MATRIX.map((point) => point.id)).toEqual([
      "admission-atomicity",
      "duplicate-admission",
      "conflicting-admission",
      "admitted-not-promoted",
      "promoted-not-drained",
      "leftover-steer",
      "operator-control",
      "unreadable-config-at-boot",
    ])
  })
})
