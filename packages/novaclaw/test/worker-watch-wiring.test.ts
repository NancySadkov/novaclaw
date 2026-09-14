import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The instance graph BUILDS the fleet watcher, and the registry it reads is wired to a worker's life.
 *
 * 🔴 Same hazard as `agent-removal-wiring.test.ts`, and the same reason a unit test cannot see it:
 * importing a node without listing it compiles green and ships dead. Here that would mean an
 * instance with no fleet view at all — the exact state this work exists to end, restored silently.
 *
 * ⚠️ The registry half matters just as much and fails the other way. If `register` is called and the
 * release is not wired to EVERY exit, the fleet view fills with pids of processes that are gone —
 * and a pid the OS has since handed to somebody else. Over-reporting a fleet is how a future kill
 * path shoots a stranger, so the `ensuring` is asserted, not just the `register`.
 */

const read = (...segments: string[]) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ...segments), "utf8")

const server = read("src", "server", "routes", "instance", "httpapi", "server.ts")
const execution = read("src", "session-worker", "execution.ts")

/**
 * Does this source release the worker's registry entry on EVERY exit — success, failure and
 * interrupt — rather than only on the happy path?
 *
 * ⚠️ It is a FUNCTION over the source text, not an inline `toMatch`, so the negative control below
 * can exercise the very same logic. The version before 2026-09-15 asserted the one-line literal
 * `Effect.ensuring(Effect.sync(releaseWorker))`, which had two faults: it broke on a legitimate
 * refactor (a second cleanup call added inside the same `Effect.sync` body, which the formatter then
 * split across lines), and its negative control tested a COPY of the regex — so greening the real
 * assertion by editing it would have left the control still passing.
 *
 * Whitespace is collapsed so formatting cannot decide the answer, and the search is anchored on the
 * RELEASE rather than on the first `ensuring` in the file: `execution.ts` has another one
 * (`Effect.ensuring(driveState.unpin(sessionID))`) and picking that one asserts nothing.
 */
const releaseRunsOnEveryExit = (source: string) => {
  const collapsed = source.replace(/\s+/g, " ")
  const release = collapsed.indexOf("releaseWorker()")
  if (release < 0) return false
  // The nearest `Effect.ensuring(` before the release, then its MATCHING closing paren. A distance
  // window is not enough: a release placed after the block is still "within 300 characters" of it,
  // and the negative control below caught exactly that when this used a window.
  const start = collapsed.lastIndexOf("Effect.ensuring(", release)
  if (start < 0) return false
  const open = collapsed.indexOf("(", start)
  let depth = 0
  for (let i = open; i < collapsed.length; i++) {
    if (collapsed[i] === "(") depth++
    else if (collapsed[i] === ")") {
      depth--
      // The release must lie INSIDE the block, before the paren that closes it. This subsumes the
      // interrupt case too: a release wired only to `onInterrupt` has no `ensuring` in front of it.
      if (depth === 0) return release < i
    }
  }
  return false
}

describe("the instance graph carries the fleet watcher", () => {
  test("the node is in the list, not merely imported", () => {
    expect(server).toContain("WorkerWatch.node,")
  })

  test("it is imported from the module that owns the tick", () => {
    expect(server).toContain('from "@/storage/worker-watch"')
  })

  test("it sits beside the spawn-pressure node — both are host-memory guards", () => {
    const watch = server.indexOf("WorkerWatch.node,")
    const pressure = server.indexOf("SpawnPressure.node,")
    expect(watch).toBeGreaterThan(0)
    expect(pressure).toBeGreaterThan(0)
    // Adjacent so the two halves of "can this host afford it" are read together: one refuses new
    // work at the door, the other watches what is already inside.
    expect(Math.abs(watch - pressure)).toBeLessThan(500)
  })
})

describe("a worker's registration matches its life", () => {
  test("execution admission runs before a process can start", () => {
    expect(execution).toContain('from "./admission"')
    expect(execution).toContain("return yield* workerAdmission.run(")
    expect(execution.indexOf("workerAdmission.run")).toBeLessThan(execution.indexOf("SessionWorkerSupervisor.spawn"))
  })

  test("execution registers the spawned worker", () => {
    expect(execution).toContain("WorkerRegistry.register(")
    expect(execution).toContain("pid: spawned.value.pid")
  })

  test("🔴 the release is wired to EVERY exit, not just the happy one", () => {
    // `ensuring` runs on success, failure AND interrupt. `onInterrupt` alone would leak an entry for
    // every worker that merely failed — and a leaked entry names a pid that may now belong to
    // somebody else's process.
    expect(releaseRunsOnEveryExit(execution)).toBe(true)
  })

  test("NEGATIVE CONTROL: the reader would notice if the release went away", () => {
    // The SAME predicate the assertion above uses, not a copy of it — a control that restates the
    // logic can keep passing after the real assertion has been edited into uselessness.
    // The shape the real source has, whitespace-normalised: passes.
    expect(releaseRunsOnEveryExit("Effect.ensuring(Effect.sync(() => { releaseWorker() }))")).toBe(true)
    // The release wired only to the INTERRUPT path — the exact leak this test exists to catch.
    expect(releaseRunsOnEveryExit("Effect.onInterrupt(() => { releaseWorker() })")).toBe(false)
    // No `ensuring` at all.
    expect(releaseRunsOnEveryExit("outcome = yield* Effect.promise(() => spawned.value.result)")).toBe(false)
    // An `ensuring` that wraps something else, with the release left outside it.
    expect(
      releaseRunsOnEveryExit("Effect.ensuring(driveState.unpin(sessionID)) ; somethingElse() ; releaseWorker()"),
    ).toBe(false)
  })
})
