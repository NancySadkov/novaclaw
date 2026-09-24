import { describe, expect, test } from "bun:test"
import { SessionDrive } from "./drive"

// The self-drive decision: a goal-oriented officer stays alive until Stop.

const t0 = 1_000_000

describe("SessionDrive.decide", () => {
  test("drives self-declared autonomous sessions and delegated workers", () => {
    const state = SessionDrive.initialState(t0)
    expect(SessionDrive.decide({ type: "goal-oriented" }, state, t0).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "interactive" }, state, t0).kind).toBe("idle")
    expect(SessionDrive.decide({ type: "sub-agent" }, state, t0).kind).toBe("continue")
    expect(SessionDrive.decide({}, state, t0).kind).toBe("idle") // undefined type = interactive default
    expect(SessionDrive.decide(undefined, state, t0).kind).toBe("idle") // missing row = never drive
  })

  test("a terminal result never kills a goal-oriented officer", () => {
    const state = SessionDrive.initialState(t0)
    expect(SessionDrive.decide({ type: "goal-oriented", result: "" }, state, t0).kind).toBe("continue")
  })

  test("long-horizon work has no round or wall-clock completion authority", () => {
    const state = SessionDrive.initialState(t0)
    state.rounds = Number.MAX_SAFE_INTEGER
    expect(SessionDrive.decide({ type: "goal-oriented" }, state, Number.MAX_SAFE_INTEGER).kind).toBe("continue")
    expect(SessionDrive.decide({ type: "sub-agent" }, state, Number.MAX_SAFE_INTEGER).kind).toBe("continue")
  })

  test("the continuation message teaches exit()", () => {
    const state = SessionDrive.initialState(t0)
    const goal = SessionDrive.decide({ type: "goal-oriented" }, state, t0)
    if (goal.kind !== "continue") throw new Error("expected continue")
    expect(goal.message).toContain("`exit` tool")
    expect(goal.message).toContain("goal")
  })

  test("the goal drive names the first unfinished plan step and does NOT repeat the goal", () => {
    // 🔴 Re-pinned 2026-09-16 (owner): the goal moved into the SYSTEM PROMPT
    // (*"Goal prompt is appended to system prompt, right after the tool specification and before the
    // user prompt"*), so this steer stopped restating it. One objective, one place: two copies in the
    // same request is how the steer and the prompt come to disagree, and the copy the model acts on
    // would be whichever it read last.
    const decision = SessionDrive.decide({ type: "goal-oriented" }, SessionDrive.initialState(t0), t0, {
      goal: "Ship C8",
      steps: [
        { text: "already checked", status: "completed", verdict: { check: "test", evidence: "exit 0" } },
        { text: "wire self-drive", status: "pending", verdict: null },
      ],
    })
    expect(decision).toMatchObject({ kind: "continue" })
    if (decision.kind !== "continue") throw new Error("expected continue")
    expect(decision.message).toContain("wire self-drive")
    expect(decision.message).not.toContain("already checked")
    expect(decision.message).not.toContain("Ship C8")
    expect(decision.message).toContain("set out at the end of your system prompt")
  })

  test("🔴 a session with NO goal is never told to author one", () => {
    // Owner, 2026-09-16: *"The goal is something user or agent's Superior officer sets. Agent can't set
    // its own goal (i.e. no set your durable goal nudges)."* The steer used to say *"Declare the durable
    // `goal` component from the opening request"* — an instruction to author its own objective, naming a
    // write that a default install DENIES. Both halves were wrong, so both are asserted gone.
    const decision = SessionDrive.decide({ type: "goal-oriented" }, SessionDrive.initialState(t0), t0, {
      steps: [],
    })
    if (decision.kind !== "continue") throw new Error("expected continue")
    expect(decision.message).not.toContain("Declare the durable")
    expect(decision.message).not.toContain("durable `goal` component")
    expect(decision.message).toContain("No durable goal is set")
  })

  test("assignedGoal prefers the officer's brief and falls back to the session component", () => {
    // One precedence, two readers (the drain and the system prompt). The officer's configured goal is
    // what the user or a superior officer assigned; the component is the kernel's narrower carrier.
    expect(SessionDrive.assignedGoal({ officerGoal: "Ship C8", component: { text: "component goal" } })).toBe("Ship C8")
    expect(SessionDrive.assignedGoal({ officerGoal: "   ", component: { text: "component goal" } })).toBe(
      "component goal",
    )
    expect(SessionDrive.assignedGoal({ officerGoal: undefined, component: { text: "component goal" } })).toBe(
      "component goal",
    )
    // Nothing assigned is nothing, not an empty string dressed as a goal — and never a non-goal value
    // that merely happens to be an object.
    expect(SessionDrive.assignedGoal({ officerGoal: undefined, component: undefined })).toBeUndefined()
    expect(SessionDrive.assignedGoal({ officerGoal: undefined, component: { other: 1 } })).toBeUndefined()
    expect(SessionDrive.assignedGoal({ officerGoal: undefined, component: "Ship C8" })).toBeUndefined()
  })

  test("🔴 unattendedMode is decided from the ROLE, so the switch lands on the next turn", () => {
    // Owner, 2026-09-16: *"Switching agent from Interactive mode to Unattended or back should take
    // immediate effects with adding/removing goal to its context, even if that will lead to prompt
    // prefix cache misses."* `operationMode` is read per turn; the type column is stamped at creation,
    // so on its own it would make the switch wait for the UI's second `switchType` call.
    expect(SessionDrive.unattendedMode({ operationMode: "unattended", sessionType: "interactive" })).toBe(true)
    expect(SessionDrive.unattendedMode({ operationMode: "interactive", sessionType: "goal-oriented" })).toBe(false)
    // Absent role statement: the chat's classification is the only one there is.
    expect(SessionDrive.unattendedMode({ operationMode: undefined, sessionType: "goal-oriented" })).toBe(true)
    expect(SessionDrive.unattendedMode({ operationMode: undefined, sessionType: "interactive" })).toBe(false)
    expect(SessionDrive.unattendedMode({ operationMode: undefined, sessionType: undefined })).toBe(false)
  })

  test("🔴 the drive reads the ROLE's mode, so a switch lands without the second switchType request", () => {
    // Owner, 2026-09-16. The prompt half already used `unattendedMode`; the drain read only the
    // stamped `type`, so an Interactive chat switched to Unattended kept idling (and one switched
    // back kept self-driving/sleeping) until a user prompt. Both directions, one source.
    const state = SessionDrive.initialState(t0)
    expect(SessionDrive.decide({ type: "interactive" }, state, t0, undefined, { operationMode: "unattended" }).kind).toBe(
      "continue",
    )
    expect(
      SessionDrive.decide({ type: "goal-oriented" }, state, t0, undefined, { operationMode: "interactive" }).kind,
    ).toBe("idle")
    // A role that declares nothing leaves the chat's own classification in charge.
    expect(
      SessionDrive.decide({ type: "goal-oriented" }, state, t0, undefined, { operationMode: undefined }).kind,
    ).toBe("continue")
    expect(
      SessionDrive.decide({ type: "interactive" }, state, t0, undefined, { operationMode: undefined }).kind,
    ).toBe("idle")
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
