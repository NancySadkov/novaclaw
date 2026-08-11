import { describe, expect, test } from "bun:test"
import { NovaHealth } from "@novaclaw/core/nova-health"

const ok = (id: string): NovaHealth.Signal => ({ id, label: id, status: "ok" })

describe("NovaHealth.worst — unknown is not a tick", () => {
  test("all ok is ok", () => {
    expect(NovaHealth.worst([ok("a"), ok("b")])).toBe("ok")
  })

  // 🔴 The rule this module exists for. A board with one unreadable probe is not healthy, it is
  // incompletely known — and the difference is the whole reason someone opened the screen.
  test("one unknown beats every ok", () => {
    expect(NovaHealth.worst([ok("a"), { id: "b", label: "b", status: "unknown" }])).toBe("unknown")
  })

  // A thing we measured and found wanting is more actionable than a thing we could not measure.
  test("warning and problem both outrank unknown", () => {
    const unknown: NovaHealth.Signal = { id: "u", label: "u", status: "unknown" }
    expect(NovaHealth.worst([unknown, { id: "w", label: "w", status: "warning" }])).toBe("warning")
    expect(NovaHealth.worst([unknown, { id: "p", label: "p", status: "problem" }])).toBe("problem")
  })

  test("no signals at all is unknown, never ok", () => {
    expect(NovaHealth.worst([])).toBe("unknown")
  })
})

describe("NovaHealth.headline", () => {
  test("says everything is healthy only when it is", () => {
    expect(NovaHealth.headline([ok("a")])).toContain("healthy")
  })

  test("an unknown headline admits the board is INCOMPLETE rather than reassuring", () => {
    const line = NovaHealth.headline([ok("a"), { id: "b", label: "b", status: "unknown" }])
    expect(line).toContain("incomplete")
    expect(line).not.toContain("healthy")
  })

  test("counts what needs attention, singular and plural", () => {
    const problem: NovaHealth.Signal = { id: "p", label: "p", status: "problem" }
    expect(NovaHealth.headline([problem])).toBe("1 thing needs attention.")
    expect(NovaHealth.headline([problem, { ...problem, id: "q" }])).toBe("2 things need attention.")
  })
})

describe("mapping each subsystem's vocabulary", () => {
  test("pressure floor is a problem and names an action a person can take", () => {
    const signal = NovaHealth.fromPressure({ level: "floor", detail: "13 900 MB of 45 800 MB committed" })
    expect(signal.status).toBe("problem")
    expect(signal.action).toContain("Close some applications")
    // The action must be plain language, not a subsystem name.
    expect(signal.action).not.toContain("Pressure")
  })

  test("pressure unknown stays unknown — it does not become ok or a problem", () => {
    expect(NovaHealth.fromPressure({ level: "unknown" }).status).toBe("unknown")
    expect(NovaHealth.fromPressure({ level: "unknown" }).action).toBeUndefined()
  })

  test("a damaged store is a problem, and the action says nothing is deleted", () => {
    const signal = NovaHealth.fromDatabase({ status: "damaged", detail: "malformed" })
    expect(signal.status).toBe("problem")
    expect(signal.action).toContain("without deleting")
  })

  // ⚠️ The user turned the airgap on. Offering to "fix" a setting they chose would be the product
  // second-guessing them, so `blocked` is a warning with NO repair.
  test("a blocked provider is a warning with no action", () => {
    const signal = NovaHealth.fromProvider({ name: "spark", verdict: "blocked" })
    expect(signal.status).toBe("warning")
    expect(signal.action).toBeUndefined()
    expect(signal.detail).toContain("Offline mode")
  })

  test("an unreachable provider is a problem and points at the endpoint", () => {
    const signal = NovaHealth.fromProvider({ name: "spark", verdict: "unreachable" })
    expect(signal.status).toBe("problem")
    expect(signal.action).toContain("endpoint")
  })

  test("a stopped scheduler is a problem; a readable running one is ok", () => {
    expect(NovaHealth.fromScheduler(false).status).toBe("problem")
    expect(NovaHealth.fromScheduler(true).status).toBe("ok")
    expect(NovaHealth.fromScheduler(undefined).status).toBe("unknown")
  })

  // ⚠️ UPDATER_ENABLED lives in the desktop main process. Claiming updates are OFF when the server
  // simply cannot see the flag is a false description of the user's own configuration.
  test("an unreadable updater flag is unknown, never off", () => {
    const signal = NovaHealth.fromUpdater(undefined)
    expect(signal.status).toBe("unknown")
    expect(signal.detail).toContain("desktop-only")
    expect(signal.detail ?? "").not.toContain("Off,")
  })

  test("a readable updater reports its real setting", () => {
    expect(NovaHealth.fromUpdater(false).detail).toContain("Off, by your setting")
    expect(NovaHealth.fromUpdater(true).detail).toContain("On.")
  })
})

// A composed board, the way a screen would build one.
describe("a whole board", () => {
  test("one unreadable probe keeps the board honest even when nothing is wrong", () => {
    const board = [
      NovaHealth.fromPressure({ level: "ok" }),
      NovaHealth.fromDatabase({ status: "ok" }),
      NovaHealth.fromScheduler(true),
      NovaHealth.fromUpdater(undefined),
    ]
    expect(NovaHealth.worst(board)).toBe("unknown")
    expect(NovaHealth.headline(board)).toContain("incomplete")
  })

  test("every non-ok row either carries an action or a reason it has none", () => {
    const board = [
      NovaHealth.fromPressure({ level: "floor" }),
      NovaHealth.fromDatabase({ status: "damaged" }),
      NovaHealth.fromProvider({ name: "spark", verdict: "unreachable" }),
      NovaHealth.fromProvider({ name: "cloud", verdict: "blocked" }),
      NovaHealth.fromScheduler(false),
    ]
    for (const signal of board.filter((s) => s.status !== "ok"))
      expect(signal.action !== undefined || signal.detail !== undefined).toBe(true)
  })
})
