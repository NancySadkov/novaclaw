import { expect, test } from "bun:test"
import { ScheduleExecutionSettings as Settings } from "./execution-settings"

const known = {
  agents: new Set(["nova", "theron"]),
}

test("settings that name a real colleague are accepted", () => {
  expect(Settings.refusal({ agent: "theron" }, known)).toBeUndefined()
})

test("🔴 ABSENT is legal — that is a choice, not a mistake", () => {
  /**
   * Omitting an agent means "the instance decides at fire time", which a user is entitled to choose.
   * Refusing it would force every schedule to name a colleague that might be retired before it fires.
   * Only a NAMED thing that does not exist is refused.
   */
  expect(Settings.refusal({}, known)).toBeUndefined()
  expect(Settings.refusal({ agent: undefined }, known)).toBeUndefined()
  expect(Settings.refusal({ agent: "  " }, known)).toBeUndefined()
})

test("🔴 `null` is absent too — it is how the update payload CLEARS the field", () => {
  // Treating a clear as a bad value would make unsetting an agent impossible, which is the only way
  // to undo a choice.
  expect(Settings.refusal({ agent: null }, known)).toBeUndefined()
})

test("🔴 an unknown agent is refused, and the refusal names the real ones", () => {
  /**
   * The report's complaint is that this surface "requires opaque ids". A refusal listing the actual
   * choices is the smallest form of offering them — and it reaches every caller, including the typed
   * API, which no picker can.
   *
   * A/B: return `undefined` for an unknown agent and this fails.
   */
  const message = Settings.refusal({ agent: "theron2" }, known)
  expect(message).toContain('No agent named "theron2"')
  expect(message).toContain("nova")
  expect(message).toContain("theron")
})

test("an empty instance says so rather than offering an empty list", () => {
  const bare = { agents: new Set<string>() }
  expect(Settings.refusal({ agent: "theron" }, bare)).toContain("none are configured")
})

test("the suggestion list is capped, so a big instance does not dump its roster", () => {
  const many = { agents: new Set(Array.from({ length: 40 }, (_, i) => `agent-${i}`)) }
  const message = Settings.refusal({ agent: "nope" }, many)!
  expect(message.split(",").length).toBeLessThanOrEqual(9)
})

test("🔴 an UNRESOLVED set refuses nothing — it is not an empty one", () => {
  /**
   * Measured, not reasoned: the first wiring resolved the roster through `Location.Service` in a
   * handler that carries no location middleware. It typechecked and returned 500 on every create.
   * The fix is that the handler passes `undefined` for what it could not read — so this distinction
   * is the whole safety of checking a location service from a global boundary.
   *
   * A/B: treat `undefined` as an empty set and this refuses.
   */
  expect(Settings.refusal({ agent: "anyone" }, { agents: undefined })).toBeUndefined()
})
