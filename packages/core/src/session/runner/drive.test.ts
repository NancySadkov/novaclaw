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
    expect(SessionDrive.decide({ type: "sub-agent" }, state, t0).kind).toBe("stop")
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
})
