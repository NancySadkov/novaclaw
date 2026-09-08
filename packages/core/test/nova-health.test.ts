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
    expect(NovaHealth.fromScheduler("unavailable").status).toBe("problem")
    expect(NovaHealth.fromScheduler("ready").status).toBe("ok")
    expect(NovaHealth.fromScheduler(undefined).status).toBe("unknown")
    // 🔴 The row reads the CALENDAR scheduler, not SessionScheduler (per-device admission control).
    // It was labelled "Scheduled runs" while measuring a different module with a similar name.
    expect(NovaHealth.fromScheduler("starting").status).toBe("unknown")
    expect(NovaHealth.fromScheduler("idle").status).toBe("unknown")
    expect(NovaHealth.fromScheduler("unavailable").detail).toContain("calendar")
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
      NovaHealth.fromScheduler("ready"),
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
      NovaHealth.fromScheduler("unavailable"),
    ]
    for (const signal of board.filter((s) => s.status !== "ok"))
      expect(signal.action !== undefined || signal.detail !== undefined).toBe(true)
  })
})

describe("fromModel — declared capability, and it says so", () => {
  test("a tool-capable model is ok", () => {
    expect(NovaHealth.fromModel({ name: "holo3.1", tools: true }).status).toBe("ok")
  })

  // The half-broken state worth naming BEFORE a turn fails: the product still chats and nothing
  // else works, which a person would otherwise diagnose by watching an agent do nothing.
  test("a model without tool support is a problem, in plain terms", () => {
    const signal = NovaHealth.fromModel({ name: "tiny-chat", tools: false })
    expect(signal.status).toBe("problem")
    expect(signal.detail).toContain("cannot read files or run commands")
    expect(signal.action).toContain("Settings")
  })

  test("no model selected is unknown, with the obvious action", () => {
    const signal = NovaHealth.fromModel({ name: undefined, tools: undefined })
    expect(signal.status).toBe("unknown")
    expect(signal.action).toContain("Choose a model")
  })

  // ⚠️ Declared, not probed. A model that declares tools may still choose badly — Holo-3.1 measured
  // 12/12 on one prompt and 7/12 on another with identical declarations. That is not a health
  // question, and the row must not pretend to answer it.
  test("a declared-capable model is ok even though behaviour varies", () => {
    expect(NovaHealth.fromModel({ name: "holo3.1", tools: true }).detail).toBe("holo3.1")
  })
})

describe("NovaHealth.fromMemory", () => {
  /**
   * 🔴 This signal exists because its ABSENCE was the defect. Fault injection 2026-08-12 showed the
   * product survives an unopenable memory graph exactly as designed, then tells the user "Nothing
   * remembered yet … no setup needed" — indistinguishable from a healthy new install, so nobody
   * looks. The board that answers "is anything wrong?" could not answer for it.
   */
  test("an ERRORED engine is a PROBLEM that names the consequence and offers repair", () => {
    const signal = NovaHealth.fromMemory({ stage: "error" })
    expect(signal.status).toBe("problem")
    expect(signal.id).toBe("memory")
    // The consequence, in the user's terms — "the graph failed to open" tells a non-expert nothing
    // about what they have lost.
    expect(signal.detail).toContain("Nothing is being remembered")
    expect(signal.action).toBeDefined()
  })

  test("an extra detail is appended, not swallowed", () => {
    const signal = NovaHealth.fromMemory({ stage: "error", detail: "EEXIST on the store folder." })
    expect(signal.detail).toContain("Nothing is being remembered")
    expect(signal.detail).toContain("EEXIST on the store folder.")
  })

  test("not-loaded is UNKNOWN, never ok — we have not opened the store, so we cannot claim it opens", () => {
    // ⚠️ The tempting bug: reporting a lazily-unbuilt subsystem as healthy. That is the same false
    // reassurance the Memory app was giving, moved into the health board.
    const idle = NovaHealth.fromMemory({ stage: "not-loaded" })
    expect(idle.status).toBe("unknown")
    expect(idle.detail).toContain("opens the first time it is used")
    expect(NovaHealth.fromMemory({ stage: "loading" }).status).toBe("unknown")
    expect(NovaHealth.fromMemory({ stage: undefined }).status).toBe("unknown")
  })

  test("switched off deliberately is not a fault", () => {
    const off = NovaHealth.fromMemory({ stage: "disabled" })
    expect(off.status).toBe("ok")
    expect(off.detail).toContain("your setting")
  })

  test("ready is a clean tick with nothing to add", () => {
    const ready = NovaHealth.fromMemory({ stage: "ready" })
    expect(ready.status).toBe("ok")
    expect(ready.detail).toBeUndefined()
    expect(ready.action).toBeUndefined()
  })

  test("a broken store drags the whole board to `problem`", () => {
    // The point of adding the row: `worst` must SEE it. A signal that exists but cannot change the
    // overall verdict would leave the board still saying nothing is wrong.
    const board = [
      NovaHealth.fromScheduler("ready"),
      NovaHealth.fromMemory({ stage: "error" }),
      NovaHealth.fromUpdater(true),
    ]
    expect(NovaHealth.worst(board)).toBe("problem")
    expect(NovaHealth.headline(board)).not.toContain("nothing")
  })
})

describe("NovaHealth.fromWorldMemory", () => {
  test("keeps the automatic world model distinct from the explicit KB", () => {
    const signal = NovaHealth.fromWorldMemory({ stage: "error", detail: "world path is unreadable" })
    expect(signal.id).toBe("world-memory")
    expect(signal.label).toBe("Agent memory")
    expect(signal.status).toBe("problem")
    expect(signal.detail).toContain("Automatic recall")
    expect(signal.detail).toContain("world path is unreadable")
  })

  test("a disabled world model is deliberate, while an unopened one is unknown", () => {
    expect(NovaHealth.fromWorldMemory({ stage: "disabled" }).status).toBe("ok")
    expect(NovaHealth.fromWorldMemory({ stage: "not-loaded" }).status).toBe("unknown")
  })
})

describe("NovaHealth.fromCapability — the generic edge row", () => {
  /**
   * 🔴 Five capability edges are registered and until 2026-08-12 only TWO could reach this board.
   * The rest were visible solely through `/api/capability`, behind Developer mode — so a first user
   * whose messenger gateway or local model refused to start had nothing to look at.
   */
  test("names the feature in words and points at the repair surface", () => {
    const signal = NovaHealth.fromCapability("messenger-login")
    expect(signal.status).toBe("problem")
    expect(signal.id).toBe("capability:messenger-login")
    // A slug is an identifier, not something a person reads.
    expect(signal.label).toContain("messenger login")
    expect(signal.action).toContain("Debug")
    // Says what is NOT broken: an optional feature failing must not read as the app being broken.
    expect(signal.detail).toContain("rest of NovaClaw is unaffected")
  })

  test("edges with a purpose-built row are excluded, so one fault is never two rows", () => {
    // ⚠️ Those rows read the SUBSYSTEM's own state, which is strictly better than the edge's:
    // memory's engine can be broken while its capability still reads `ready`.
    expect(NovaHealth.NAMED_CAPABILITY_ROWS.has("memory")).toBe(true)
    expect(NovaHealth.NAMED_CAPABILITY_ROWS.has("calendar-scheduler")).toBe(true)
    expect(NovaHealth.NAMED_CAPABILITY_ROWS.has("messenger")).toBe(false)
  })

  test("a down optional feature drags the board to problem", () => {
    const board = [NovaHealth.fromScheduler("ready"), NovaHealth.fromCapability("local-model")]
    expect(NovaHealth.worst(board)).toBe("problem")
  })
})

test("🔴 unreadable stored secrets are a PROBLEM with a named repair", () => {
  /**
   * An unreadable credential needs an account reconnection or identity backup restore. The board
   * must give that repair path because waiting does not make the credential readable.
   *
   * A/B: return `status: "warning"` and this fails.
   */
  const signal = NovaHealth.fromCredentials({ unreadable: 2, notice: "2 stored secrets cannot be read." })
  expect(signal.status).toBe("problem")
  expect(signal.detail).toContain("2 stored secrets")
  expect(signal.action).toContain("identity backup")
})

test("a healthy instance reports the row as ok, with nothing to do", () => {
  // The board shows every signal, so this row exists on a healthy instance too. It must not carry an
  // action there — an offer to repair something that is not broken teaches users to ignore actions.
  const signal = NovaHealth.fromCredentials({ unreadable: 0 })
  expect(signal.status).toBe("ok")
  expect(signal.action).toBeUndefined()
  expect(signal.detail).toBeUndefined()
})
