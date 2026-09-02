import { expect, test } from "bun:test"
import { failureDetail, pausedNotice } from "../../src/session-worker/execution"
import type * as SessionWorkerSupervisor from "../../src/session-worker/supervisor"

/**
 * ─── A CRASH MUST NOT BE DESCRIBED LIKE EVERY OTHER CRASH ────────────────────────────────────────
 *
 * 🔴 The supervisor reads the child's real `exit` event and carries `{type:"exited", code}` or
 * `{type:"signaled", signal}`. The renderer that turns an outcome into the transcript's *"Technical
 * detail:"* line named only two of the ten arms and let the rest fall to a catch-all keyed on a
 * `detail` field neither of those two has — so both the exit code and the signal name were captured
 * and then thrown away. An uncaught throw, a module missing from a packaged build and an OS OOM kill
 * all reached the user as the same five words. That is misattribution, not verbosity: the sentence
 * cannot distinguish the faults, so nothing downstream of it can either.
 */

const outcomes: readonly SessionWorkerSupervisor.Outcome[] = [
  { type: "settled" },
  { type: "failed", classification: "worker-start", detail: "spawn ENOENT" },
  { type: "start-timeout" },
  { type: "heartbeat-timeout" },
  { type: "memory-limit", rssBytes: 3000 * 1024 * 1024, limitBytes: 2048 * 1024 * 1024 },
  { type: "protocol-error", detail: "worker message is not valid JSON" },
  { type: "stale-message" },
  { type: "exited", code: 42 },
  { type: "signaled", signal: "SIGKILL" },
  { type: "interrupted" },
]

test("a worker that exits non-zero and one killed by a signal say WHICH, and do not say the same thing", () => {
  const exited = failureDetail({ type: "exited", code: 42 })
  const signaled = failureDetail({ type: "signaled", signal: "SIGKILL" })

  expect(exited).toContain("42")
  expect(signaled).toContain("SIGKILL")
  // The defect was not a missing number, it was two different deaths reading identically.
  expect(exited).not.toBe(signaled)

  // A different code is a different sentence — otherwise "names the code" is decoration.
  expect(failureDetail({ type: "exited", code: 1 })).not.toBe(exited)
  expect(failureDetail({ type: "signaled", signal: "SIGTERM" })).not.toBe(signaled)

  // And it survives the trip to the person, which is the only place it is ever read.
  expect(pausedNotice("repeated-failure", exited)).toContain("Technical detail:")
  expect(pausedNotice("repeated-failure", exited)).toContain("42")
})

test("control: the arms that already carried their own detail are unchanged", () => {
  expect(failureDetail({ type: "failed", classification: "worker-start", detail: "spawn ENOENT" })).toBe(
    "worker-start: spawn ENOENT",
  )
  expect(failureDetail({ type: "failed", classification: "worker-start" })).toBe("worker-start")
  expect(
    failureDetail({ type: "memory-limit", rssBytes: 3000 * 1024 * 1024, limitBytes: 2048 * 1024 * 1024 }),
  ).toContain("3000 MiB used")
  expect(failureDetail({ type: "protocol-error", detail: "worker message is not valid JSON" })).toContain(
    "worker message is not valid JSON",
  )
})

test("no two worker outcomes share a description, and none renders an empty one", () => {
  // ⚠️ The real guard is the compile-time one: the renderer is a switch closed by `satisfies never`,
  // so an eleventh `Outcome` member does not build until someone writes its sentence. This is the
  // runtime half — it fails if two arms are ever given the same words, which is the shape the bug had.
  const rendered = outcomes.map(failureDetail)
  expect(rendered.filter((line) => line.length === 0)).toEqual([])
  expect(new Set(rendered).size).toBe(rendered.length)
  // Nothing may render as the bare type tag: that is the catch-all's signature.
  for (const outcome of outcomes) expect(failureDetail(outcome)).not.toBe(`session worker ${outcome.type}`)
})
