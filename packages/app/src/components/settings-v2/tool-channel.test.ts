import { describe, expect, test } from "bun:test"
import { configuredChannel, status, type ConfigLike } from "./tool-channel"

/**
 * Who decided this model's tool channel — the one thing this surface owes the user.
 *
 * When the channel is wrong the agent silently cannot act and the chat reads as a model refusing.
 * Every case below is a way the screen could name the wrong decider, which is worse than saying
 * nothing: the user would go and change something that was never in force.
 */

const HERE = "http://spark:8010/v1"

const measured = (
  choice: string,
  rationale = "native dropped an argument",
  endpoint: string | undefined = HERE,
): ConfigLike => ({
  provider_capability: { "p/m": { choice, rationale, measuredAt: 1_700_000_000_000, endpoint } },
})

const configured = (toolChannel: unknown): ConfigLike => ({
  providers: { p: { models: { m: { request: { body: { toolChannel } } } } } },
})

describe("who decided the tool channel", () => {
  test("nothing said anywhere is the protocol default, and says so", () => {
    expect(status(undefined, "p", "m")).toEqual({ channel: "native", source: "default" })
    expect(status({}, "p", "m")).toEqual({ channel: "native", source: "default" })
  })

  test("a measurement is reported as measured, with its reason and its age", () => {
    const result = status(measured("prompted"), "p", "m")
    expect(result.channel).toBe("prompted")
    expect(result.source).toBe("measured")
    expect(result.rationale).toBe("native dropped an argument")
    // Kept so the surface can say HOW OLD the answer is instead of implying it is fresh.
    expect(result.measuredAt).toBe(1_700_000_000_000)
  })

  test("🔴 an operator override WINS and the overridden measurement is still shown", () => {
    // The most confusing state this screen can be in is "I tested it and it still does the other
    // thing". Hiding the measurement is what makes that unexplainable.
    const result = status({ ...measured("prompted"), ...configured("native") }, "p", "m")
    expect(result.channel).toBe("native")
    expect(result.source).toBe("configured")
    expect(result.overriddenMeasurement).toEqual({ channel: "prompted", rationale: "native dropped an argument" })
  })

  test("an override that AGREES with the measurement is not reported as a conflict", () => {
    const result = status({ ...measured("prompted"), ...configured("prompted") }, "p", "m")
    expect(result.source).toBe("configured")
    expect(result.overriddenMeasurement).toBeUndefined()
  })

  test("🔴 an inconclusive verdict does not masquerade as a chosen channel", () => {
    // `chat-only` and `unknown` are real answers that select nothing, so the model runs on the
    // protocol default. Showing "native" as though it had been decided would be a claim nobody made.
    for (const choice of ["chat-only", "unknown"] as const) {
      const result = status(measured(choice), "p", "m")
      expect(result.source).toBe("default")
      expect(result.inconclusive).toBe(choice)
    }
  })

  test("🔴 an unknown configured value is IGNORED, mirroring the kernel", () => {
    // The kernel drops anything but the two known values, so the model stays on its native default.
    // Displaying a typo as a decision sends the user looking for the effect of a setting that is not
    // in force.
    for (const value of ["Prompted", "text", "", 1, true, null])
      expect(configuredChannel(configured(value), "p", "m")).toBeUndefined()
    expect(status(configured("Prompted"), "p", "m").source).toBe("default")
  })

  test("🔴 a measurement from a DIFFERENT endpoint stops being in force, and says so", () => {
    // "Never tested" and "tested, but the endpoint moved" are different facts, and only the second is
    // something a person can act on. The runner already discards the stale row, so reporting it as
    // `measured` would be the screen claiming a verdict is in force when it is not.
    const result = status(measured("prompted"), "p", "m", "http://elsewhere:9000/v1")
    expect(result.source).toBe("default")
    expect(result.channel).toBe("native")
    expect(result.movedFrom).toBe(HERE)
    // The stale reason must not ride along — it describes somewhere else.
    expect(result.rationale).toBeUndefined()
  })

  test("a trailing slash is not a move", () => {
    // The kernel's fingerprint normalises it; a screen that disagreed would report a move nobody made.
    expect(status(measured("prompted"), "p", "m", HERE + "/").movedFrom).toBeUndefined()
  })

  test("🔴 no move is claimed when either side is unknown", () => {
    // A row written before the endpoint was recorded, or a caller that cannot supply the current one,
    // must not send someone re-testing a model nothing is wrong with.
    expect(status(measured("prompted", "why", undefined), "p", "m", HERE).movedFrom).toBeUndefined()
    expect(status(measured("prompted"), "p", "m").movedFrom).toBeUndefined()
    expect(status(measured("prompted"), "p", "m").source).toBe("measured")
  })

  test("an operator override still runs when the endpoint moved, and the move is still reported", () => {
    // The override is about THIS model and remains in force; the measurement it would have overridden
    // is about somewhere else, so it is not shown as overridden.
    const cfg = { ...measured("prompted"), ...configured("native") }
    const result = status(cfg, "p", "m", "http://elsewhere:9000/v1")
    expect(result.source).toBe("configured")
    expect(result.channel).toBe("native")
    expect(result.movedFrom).toBe(HERE)
    expect(result.overriddenMeasurement).toBeUndefined()
  })

  test("another model's entries do not leak in", () => {
    expect(status(measured("prompted"), "p", "other").source).toBe("default")
    expect(status(configured("prompted"), "other", "m").source).toBe("default")
  })
})
