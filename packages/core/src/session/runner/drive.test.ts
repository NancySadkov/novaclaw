import { describe, expect, test } from "bun:test"
import { SessionDrive } from "./drive"

// The self-drive decision (architecture.md "run until exit()"): drive only sessions that DECLARE
// an unattended type, stop the moment exit's projected result lands, and enforce the Vision's
// budget/step caps (rounds + wall clock — the paperclip-maximizer guard).

const t0 = 1_000_000

describe("SessionDrive.decide", () => {
  test("drives only self-declared auto-prompting / goal-oriented sessions", () => {
    const state = SessionDrive.initialState(t0)
    expect(SessionDrive.decide({ type: "auto-prompting" }, state, t0).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "goal-oriented" }, state, t0).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "interactive" }, state, t0).kind).toBe("stop")
    // ⚠️ CHANGED 2026-08-20: a sub-agent no longer stops, it SETTLES. It still does not self-drive —
    // that is what this test is about, and `settle` injects no prompt — but a spawned child whose
    // queue ran dry has a parent that may be blocked on `wait`, and leaving it unsettled meant the
    // join timed out while the child's answer sat in its transcript. See `session-drive-settle.test.ts`.
    expect(SessionDrive.decide({ type: "sub-agent" }, state, t0).kind).toBe("settle")
    expect(SessionDrive.decide({}, state, t0).kind).toBe("stop") // undefined type = interactive default
    expect(SessionDrive.decide(undefined, state, t0).kind).toBe("stop") // missing row = never drive
  })

  test("exit(result) is terminal — even a bare exit's empty-string result stops the drive", () => {
    const state = SessionDrive.initialState(t0)
    expect(SessionDrive.decide({ type: "auto-prompting", result: "done" }, state, t0).kind).toBe("stop")
    expect(SessionDrive.decide({ type: "goal-oriented", result: "" }, state, t0).kind).toBe("stop")
  })

  test("the round cap pauses with a visible notice", () => {
    const state = SessionDrive.initialState(t0)
    state.rounds = SessionDrive.MAX_DRIVE_ROUNDS
    const decision = SessionDrive.decide({ type: "auto-prompting" }, state, t0)
    expect(decision.kind).toBe("cap")
    if (decision.kind === "cap") {
      expect(decision.notice).toContain(`${SessionDrive.MAX_DRIVE_ROUNDS} self-prompted rounds`)
      expect(decision.notice).toContain("sending any message continues")
    }
  })

  test("the wall-clock watchdog pauses with a visible notice", () => {
    const state = SessionDrive.initialState(t0)
    state.rounds = 1
    const decision = SessionDrive.decide({ type: "goal-oriented" }, state, t0 + SessionDrive.MAX_DRIVE_WALL_MS)
    expect(decision.kind).toBe("cap")
    if (decision.kind === "cap") expect(decision.notice).toContain("minutes")
  })

  test("one round below each cap still continues", () => {
    const state = SessionDrive.initialState(t0)
    state.rounds = SessionDrive.MAX_DRIVE_ROUNDS - 1
    expect(SessionDrive.decide({ type: "auto-prompting" }, state, t0 + SessionDrive.MAX_DRIVE_WALL_MS - 1).kind).toBe(
      "continue",
    )
  })

  test("continuation messages teach exit() and differ by type", () => {
    const state = SessionDrive.initialState(t0)
    const auto = SessionDrive.decide({ type: "auto-prompting" }, state, t0)
    const goal = SessionDrive.decide({ type: "goal-oriented" }, state, t0)
    if (auto.kind !== "continue" || goal.kind !== "continue") throw new Error("expected continue")
    expect(auto.message).toContain("`exit` tool")
    expect(goal.message).toContain("`exit` tool")
    expect(goal.message).toContain("goal")
    expect(auto.message).not.toBe(goal.message)
  })

  test("goal drive names the durable goal and first unfinished plan step", () => {
    const decision = SessionDrive.decide({ type: "goal-oriented" }, SessionDrive.initialState(t0), t0, {
      goal: "Ship C8",
      steps: [
        { text: "already checked", status: "completed", verdict: { check: "test", evidence: "exit 0" } },
        { text: "wire self-drive", status: "pending", verdict: null },
      ],
    })
    expect(decision).toMatchObject({ kind: "continue" })
    if (decision.kind !== "continue") throw new Error("expected continue")
    expect(decision.message).toContain("Ship C8")
    expect(decision.message).toContain("wire self-drive")
    expect(decision.message).not.toContain("already checked")
  })

  test("a goal terminates only when every plan step carries a mechanical verdict", () => {
    const base = { goal: "Ship C8", steps: [{ text: "test", status: "completed", verdict: null }] }
    expect(SessionDrive.decide({ type: "goal-oriented" }, SessionDrive.initialState(t0), t0, base).kind).toBe(
      "continue",
    )
    expect(
      SessionDrive.decide({ type: "goal-oriented" }, SessionDrive.initialState(t0), t0, {
        ...base,
        steps: [{ text: "test", status: "completed", verdict: { check: "bun test", evidence: "exit 0" } }],
      }),
    ).toEqual({ kind: "complete", result: "Goal verified: Ship C8 (1 mechanically checked plan steps)." })
  })
})
