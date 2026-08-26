import { describe, expect, test } from "bun:test"
import { EngineFault } from "./engine-fault"

/**
 * The messages below are QUOTED FROM THE LOG of the 2026-08-26 wedge, not invented. A predicate
 * tested against messages someone imagined would pass while missing the string that actually occurs.
 */
const REAL_FATAL = [
  'Aborted(Assertion failed: (e=pthread_mutex_timedlock(&t->mutex,&ts))==0 || e==ETIMEDOUT, "pthread mutex deadlock detected", at: /emsdk/upstream/emscripten/system/lib/libc/musl/src/thread/pthread_mutex_timedlock.c,95)',
  "RuntimeError: Out of bounds memory access",
]

describe("isFatal — a dead module is not a failed statement", () => {
  test("the messages that actually wedged the store", () => {
    for (const message of REAL_FATAL) expect(EngineFault.isFatal(new Error(message))).toBe(true)
  })

  // 🔴 The other half, and the one that decides whether this is safe to ship. If ordinary failures
  // read as fatal, one bad statement kills a healthy store for the rest of the process — strictly
  // worse than the bug being fixed. These are the shapes `persist()` was built to retry.
  test("ordinary failures stay TRANSIENT", () => {
    for (const message of [
      "Binder Exception: Table Memory does not exist.",
      "Parser exception: Invalid input <MATCH (m:Memory>",
      "Runtime exception: Unable to open database. The file is not a valid Lbug database file!",
      "Checksum verification failed",
      "nothing to checkpoint",
      "",
    ])
      expect(EngineFault.isFatal(new Error(message))).toBe(false)
  })

  test("a non-Error is tolerated rather than throwing inside the error path", () => {
    // This runs inside a `catch`. A predicate that throws there would replace a diagnosable fault
    // with an undiagnosable one.
    expect(EngineFault.isFatal(undefined)).toBe(false)
    expect(EngineFault.isFatal(null)).toBe(false)
    expect(EngineFault.isFatal("Aborted(something)")).toBe(true)
    expect(EngineFault.isFatal({ toString: () => "Out of bounds memory access" })).toBe(true)
  })

  test("matching is case-insensitive but not substring-happy", () => {
    expect(EngineFault.isFatal(new Error("aborted("))).toBe(true)
    // "aborted" as an ordinary English word must NOT kill the engine — the paren is load-bearing.
    expect(EngineFault.isFatal(new Error("the transaction was aborted by the user"))).toBe(false)
  })
})

describe("deadMessage", () => {
  test("names the ORIGINAL fault, not the call that noticed", () => {
    const message = EngineFault.deadMessage("Aborted(pthread mutex deadlock detected)")
    expect(message).toContain("pthread mutex deadlock detected")
    // and tells the operator the thing they most need to know next
    expect(message).toContain("reopening the store")
  })
})
