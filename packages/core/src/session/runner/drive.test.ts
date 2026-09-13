import { describe, expect, test } from "bun:test"
import { SessionDrive } from "./drive"

// The self-drive decision (architecture.md "run until exit()"): drive only sessions that DECLARE
// an unattended type and stop the moment exit's projected result lands.

const t0 = 1_000_000

describe("SessionDrive.decide", () => {
  test("drives self-declared autonomous sessions and delegated workers", () => {
    const state = SessionDrive.initialState(t0)
    expect(SessionDrive.decide({ type: "auto-prompting" }, state, t0).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "goal-oriented" }, state, t0).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "interactive" }, state, t0).kind).toBe("idle")
    expect(SessionDrive.decide({ type: "sub-agent" }, state, t0).kind).toBe("continue")
    expect(SessionDrive.decide({}, state, t0).kind).toBe("idle") // undefined type = interactive default
    expect(SessionDrive.decide(undefined, state, t0).kind).toBe("idle") // missing row = never drive
  })

  test("exit(result) is terminal — even a bare exit's empty-string result stops the drive", () => {
    const state = SessionDrive.initialState(t0)
    expect(SessionDrive.decide({ type: "auto-prompting", result: "done" }, state, t0).kind).toBe("terminated")
    expect(SessionDrive.decide({ type: "goal-oriented", result: "" }, state, t0).kind).toBe("terminated")
  })

  test("long-horizon work has no round or wall-clock completion authority", () => {
    const state = SessionDrive.initialState(t0)
    state.rounds = Number.MAX_SAFE_INTEGER
    expect(SessionDrive.decide({ type: "auto-prompting" }, state, Number.MAX_SAFE_INTEGER).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "goal-oriented" }, state, Number.MAX_SAFE_INTEGER).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "sub-agent" }, state, Number.MAX_SAFE_INTEGER).kind).toBe("continue")
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

  test("accepted plan evidence asks the agent to exit instead of completing on its behalf", () => {
    const base = { goal: "Ship C8", steps: [{ text: "test", status: "completed", verdict: null }] }
    expect(SessionDrive.decide({ type: "goal-oriented" }, SessionDrive.initialState(t0), t0, base).kind).toBe(
      "continue",
    )
    const accepted = SessionDrive.decide({ type: "goal-oriented" }, SessionDrive.initialState(t0), t0, {
      ...base,
      steps: [{ text: "test", status: "completed", verdict: { check: "bun test", evidence: "exit 0" } }],
    })
    expect(accepted.kind).toBe("continue")
    if (accepted.kind !== "continue") throw new Error("expected continue")
    expect(accepted.message).toContain("accepted every plan step")
    expect(accepted.message).toContain("explicit `exit` call")
  })

  test("a stagnant unattended plan sleeps ten minutes without declaring completion", () => {
    const state = SessionDrive.initialState(t0)
    const context = { goal: "Wait for the network", steps: [] }
    let decision: SessionDrive.DriveDecision = { kind: "idle" }
    for (let round = 0; round < 7; round++)
      decision = SessionDrive.decide({ type: "goal-oriented" }, state, t0 + round, context)
    expect(decision).toEqual({
      kind: "sleep",
      milliseconds: 600_000,
      message: expect.stringContaining("Re-check the environment"),
    })
    expect(SessionDrive.decide({ type: "interactive" }, state, t0).kind).toBe("idle")
  })
})
