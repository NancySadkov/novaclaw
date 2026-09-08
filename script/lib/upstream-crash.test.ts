import { describe, expect, test } from "bun:test"
import { isUpstreamWatcherCrash } from "./upstream-crash"

/**
 * The retry this guards is the ONLY place the gate re-runs itself, so the detector has exactly one
 * job: recognise the upstream Bun watcher segfault and nothing else. A false positive re-runs a
 * genuine regression and reports the second result — the gate lying in the one direction that
 * matters.
 *
 * The fixture is real: this is the shape observed on 2026-08-06, when the crash fired on three
 * consecutive `core` runs and passed only on the fourth.
 */
const CRASH =
  "panic(thread 15812): Segmentation fault at address 0x68\n" +
  "oh no: Bun has crashed. This indicates a bug in Bun, not your code.\n" +
  "https://bun.report/1.3.14/wt10d9b296izG36339/DCYwatcher.nodes+6ECYwatcher.nodeo3uECYwatcher.node\n"

describe("the upstream watcher segfault is recognised", () => {
  test("exit 3, watcher.node frames, no failing assertions", () => {
    expect(isUpstreamWatcherCrash(3, CRASH)).toBe(true)
  })
})

describe("and nothing else is — every condition is load-bearing", () => {
  test("a different exit code is not it, however similar the output", () => {
    // A test failure exits 1. Retrying that would re-run a real regression and report attempt two.
    expect(isUpstreamWatcherCrash(1, CRASH)).toBe(false)
    expect(isUpstreamWatcherCrash(0, CRASH)).toBe(false)
    expect(isUpstreamWatcherCrash(null, CRASH)).toBe(false)
  })

  test("a crash in a DIFFERENT native module is not it", () => {
    // Another segfault is a different fault with a different cause; retrying it silently would hide
    // a real one behind an alibi that belongs to this bug.
    expect(isUpstreamWatcherCrash(3, CRASH.replace(/watcher\.node/g, "sqlite3.node"))).toBe(false)
  })

  test("🔴 a crash that ALSO reported failing assertions is NOT it", () => {
    // The decisive guard. `(fail)` lines mean something real broke before the process died, so the
    // crash is a symptom rather than the story — and a retry would discard the evidence and quite
    // possibly come back green.
    expect(isUpstreamWatcherCrash(3, `${CRASH}\n(fail) MessengerStore.chargeInitiation > the budget survives\n`)).toBe(
      false,
    )
  })

  test("empty or unrelated output never matches", () => {
    expect(isUpstreamWatcherCrash(3, "")).toBe(false)
    expect(isUpstreamWatcherCrash(3, "error: script exited with code 3\n")).toBe(false)
  })
})
