import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SessionSchema } from "../session/schema"
import { deadChildMessage, resolveDirectChildID, sideEffect } from "./wait"

const id = (value: string) => SessionSchema.ID.make(value)

test("wait is recovery-safe because observing a child cannot duplicate its work", () => {
  expect(sideEffect).toBe("read")
})

test("an already-halted worker is classified before the blocking join", () => {
  const source = readFileSync(new URL("./wait.ts", import.meta.url), "utf8")
  const precheck = source.indexOf("const alreadyDead = deadChildMessage")
  const join = source.indexOf("const joined = yield* join.awaitCompletion")
  expect(precheck).toBeGreaterThan(0)
  expect(join).toBeGreaterThan(precheck)
})

describe("resolveDirectChildID — tolerate one unambiguous opaque-id typo", () => {
  test("keeps an exact direct child authoritative", () => {
    const exact = id("ses_fa721b947ffe3Y6fwGD9siiTiI")
    expect(resolveDirectChildID(exact, [id("ses_other"), exact])).toBe(exact)
  })

  test.each(["ses_fa721b947ffe3Y6fwGD9ciiTiI", "ses_fa721b947ffe3Y6fwGD9siiTi", "ses_fa721b947ffe3Y6fwGD9xsiiTiI"])(
    "repairs one substitution, deletion, or insertion inside a direct child id",
    (mistyped) => {
      const child = id("ses_fa721b947ffe3Y6fwGD9siiTiI")
      expect(resolveDirectChildID(id(mistyped), [child])).toBe(child)
    },
  )

  test("refuses two edits instead of guessing", () => {
    expect(resolveDirectChildID(id("ses_child_zz"), [id("ses_child_ab")])).toBeUndefined()
  })

  test("refuses an ambiguous one-edit match", () => {
    expect(resolveDirectChildID(id("ses_child_ax"), [id("ses_child_ab"), id("ses_child_ac")])).toBeUndefined()
  })

  test("never resolves outside the supplied direct-child authority", () => {
    expect(resolveDirectChildID(id("ses_sibling"), [])).toBeUndefined()
  })
})

/**
 * 🔴 **The defect this exists for, measured 2026-08-27 on a delegated 100-file run:** `spawn:10`
 * against `wait:9` and `exit:9`. Ten children were started, nine were waited on and exited, and one
 * was launched and never accounted for. The run completed anyway, so nothing surfaced it.
 *
 * ⭐ That is the dangerous shape for a fan-out: nine slices of ten merge into a plausible,
 * complete-looking, WRONG answer, and the nine successes are precisely what hide the tenth.
 */
describe("deadChildMessage — a dead child must not read as a slow one", () => {
  test("a FAILED or INTERRUPTED child is reported as not-finished work for a fresh replacement", () => {
    for (const state of ["failed", "interrupted"]) {
      const message = deadChildMessage("ses_child", state)
      expect(message).toBeDefined()
      // The three things the parent has to learn, because it will act on this sentence alone.
      expect(message).toContain("DID NOT FINISH")
      expect(message).toContain("waiting again will not help")
      expect(message).toContain("spawn a fresh replacement session")
    }
  })

  test("it says WHICH failure, so the parent is not left guessing", () => {
    expect(deadChildMessage("ses_a", "failed")).toContain("failed")
    expect(deadChildMessage("ses_a", "interrupted")).toContain("was interrupted")
  })

  test("it names the child, because a fan-out has several", () => {
    expect(deadChildMessage("ses_seven", "failed")).toContain("ses_seven")
  })

  /**
   * 🔴 **The half that decides whether this is safe to ship.** Calling a LIVE child dead sends the
   * parent to duplicate work already in flight — the opposite error, and an expensive one on a device
   * this fan-out exists to saturate. `recovering` comes back on its own; `starting`/`busy` obviously
   * so.
   *
   * ⚠️ `paused` used to be asserted here, on the strength of a comment claiming it was "still
   * alive". It is not: nothing in the recovery machinery leaves that state without an operator
   * calling `authorizeRetry`, so the parent was told to keep waiting for a child that would never
   * finish. The criterion is *will anything move this child without a human*, not *did something go
   * wrong* — see the two cases below.
   */
  test("every state that can still finish is NOT dead", () => {
    for (const state of ["starting", "busy", "recovering", "settled"])
      expect(deadChildMessage("ses_child", state)).toBeUndefined()
  })

  /**
   * 🔴 **A PAUSED child is parked, not slow.** `SessionExecutionAttempt.recoverStale` writes
   * `paused` exactly when `SessionRecoveryDecision.decide` returns `automatic: false`, and
   * `SessionBootRecovery.resumeInterrupted` filters on `decision.automatic` — so the only thing that
   * leaves `paused` is `authorizeRetry`, an operator action. Telling the parent "it may still be
   * working" is a ten-minute wait loop with no end.
   */
  test("a PAUSED child is terminal, and says so in its own words", () => {
    const message = deadChildMessage("ses_child", "paused")
    expect(message).toBeDefined()
    expect(message).toContain("DID NOT FINISH")
    expect(message).toContain("PAUSED")
    expect(message).toContain("will not resume on its own")
    expect(message).toContain("waiting again will not help")
  })

  /**
   * The distinction is load-bearing: a failed slice is re-issued, a paused one may have left a tool
   * half-applied, so the parent must not be handed the same "spawn a replacement" instruction.
   */
  test("paused does not borrow the failure wording", () => {
    expect(deadChildMessage("ses_child", "paused")).not.toContain("spawn a replacement")
    expect(deadChildMessage("ses_child", "failed")).not.toContain("PAUSED")
  })

  test("an ABSENT attempt row is not dead either — it may not have started", () => {
    expect(deadChildMessage("ses_child", undefined)).toBeUndefined()
    expect(deadChildMessage("ses_child", "")).toBeUndefined()
  })

  // ⚠️ A guard against the cheapest wrong implementation: `state !== "settled"` would pass every
  // positive test above and call a busy child dead.
  test("an unknown future state is treated as ALIVE, not dead", () => {
    expect(deadChildMessage("ses_child", "some-state-added-later")).toBeUndefined()
  })
})
