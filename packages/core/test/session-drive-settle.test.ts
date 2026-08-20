import { describe, expect, test } from "bun:test"
import { SessionDrive } from "@novaclaw/core/session/runner/drive"

/**
 * A spawned child must complete its join even when it never calls `exit` (owner, 2026-08-20:
 * *"they should be bulletproof, since we never know how agents are going to invoke them"*).
 *
 * Measured that day: five children spawned, five answered and stopped without `exit`, five parents
 * left blocked on `wait` for the full two-minute timeout — and each child's answer was sitting in
 * its own transcript the whole time. `exit` is a cooperative act by a model; a primitive that only
 * completes when the model remembers a tool call is not a primitive.
 */

const now = 1_000
const fresh = () => SessionDrive.initialState(now)

describe("a sub-agent settles at drain-end without exit", () => {
  test("a sub-agent that never exited is SETTLED, not stopped", () => {
    expect(SessionDrive.decide({ type: "sub-agent" }, fresh(), now)).toEqual({ kind: "settle" })
  })

  test("a sub-agent that DID exit is left alone — one completion per session", () => {
    // The result check runs before the sub-agent arm on purpose: `exit` has already published
    // `Completed`, and settling again would publish a second completion for one session.
    expect(SessionDrive.decide({ type: "sub-agent", result: "done" }, fresh(), now)).toEqual({ kind: "stop" })
    // `exit` records "" for a bare call, so empty-string is still a RESULT and still terminal.
    expect(SessionDrive.decide({ type: "sub-agent", result: "" }, fresh(), now)).toEqual({ kind: "stop" })
  })

  test("an INTERACTIVE session is never settled — nobody is joining it", () => {
    // ⚠️ The negative that matters most. Settling a session a human is talking to would mark their
    // chat "exited" the moment it went quiet, and `wait` has no claim on it.
    expect(SessionDrive.decide({ type: "interactive" }, fresh(), now)).toEqual({ kind: "stop" })
    expect(SessionDrive.decide({}, fresh(), now)).toEqual({ kind: "stop" })
    expect(SessionDrive.decide(undefined, fresh(), now)).toEqual({ kind: "stop" })
  })

  test("the driven types keep driving — settle must not swallow the self-drive", () => {
    expect(SessionDrive.decide({ type: "auto-prompting" }, fresh(), now).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "goal-oriented" }, fresh(), now).kind).toBe("continue")
    // …and their caps still fire rather than settling.
    const spent = { rounds: SessionDrive.MAX_DRIVE_ROUNDS, startedAt: now }
    expect(SessionDrive.decide({ type: "auto-prompting" }, spent, now).kind).toBe("cap")
  })

  test("an unknown thread type is stopped, not settled", () => {
    // Only `sub-agent` has a parent that might be blocked. A future type must opt in deliberately
    // rather than inherit completion semantics by falling through.
    expect(SessionDrive.decide({ type: "fork" }, fresh(), now)).toEqual({ kind: "stop" })
  })
})
