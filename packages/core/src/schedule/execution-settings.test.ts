import { expect, test } from "bun:test"
import { ScheduleExecutionSettings as Settings } from "./execution-settings"

const known = {
  agents: new Set(["nova", "theron"]),
  models: new Set(["spark/qwen3.8-27b", "anthropic/sonnet"]),
}

test("settings that name real things are accepted", () => {
  expect(Settings.refusal({ agent: "theron", model: "spark/qwen3.8-27b" }, known)).toBeUndefined()
})

test("🔴 ABSENT is legal for both fields — that is a choice, not a mistake", () => {
  /**
   * Omitting an agent means "the instance decides at fire time", which a user is entitled to choose.
   * Refusing it would force every schedule to name a colleague that might be retired before it fires.
   * Only a NAMED thing that does not exist is refused.
   */
  expect(Settings.refusal({}, known)).toBeUndefined()
  expect(Settings.refusal({ agent: undefined, model: undefined }, known)).toBeUndefined()
  expect(Settings.refusal({ agent: "  ", model: "" }, known)).toBeUndefined()
})

test("🔴 `null` is absent too — it is how the update payload CLEARS a field", () => {
  // Treating a clear as a bad value would make unsetting an agent impossible, which is the only way
  // to undo a choice.
  expect(Settings.refusal({ agent: null, model: null }, known)).toBeUndefined()
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

test("🔴 a model without a provider is a DIFFERENT mistake from an unknown one", () => {
  // "sonnet" is not an unknown model, it is an incomplete reference. Saying so is the difference
  // between the user fixing it and the user guessing.
  expect(Settings.refusal({ model: "sonnet" }, known)).toContain("missing its provider")
  expect(Settings.refusal({ model: "anthropic/haiku" }, known)).toContain('No model "anthropic/haiku"')
})

test("the agent is checked before the model, so one refusal names one fix", () => {
  // Both wrong: report the first field the user would correct, rather than a compound sentence they
  // have to parse.
  expect(Settings.refusal({ agent: "ghost", model: "nope" }, known)).toContain("No agent")
})

test("an empty instance says so rather than offering an empty list", () => {
  const bare = { agents: new Set<string>(), models: new Set<string>() }
  expect(Settings.refusal({ agent: "theron" }, bare)).toContain("none are configured")
})

test("the suggestion list is capped, so a big instance does not dump its roster", () => {
  const many = { agents: new Set(Array.from({ length: 40 }, (_, i) => `agent-${i}`)), models: new Set<string>() }
  const message = Settings.refusal({ agent: "nope" }, many)!
  expect(message.split(",").length).toBeLessThanOrEqual(9)
})

test("🔴 an UNRESOLVED set refuses nothing — it is not an empty one", () => {
  /**
   * Measured, not reasoned: the first wiring resolved the catalog through `Location.Service` in a
   * handler that carries no location middleware. It typechecked and returned 500 on every create.
   * The fix is that the handler passes `undefined` for what it could not read — so this distinction
   * is the whole safety of checking a location service from a global boundary.
   *
   * A/B: treat `undefined` as an empty set and both of these refuse.
   */
  const blind = { agents: undefined, models: undefined }
  expect(Settings.refusal({ agent: "anyone", model: "any/thing" }, blind)).toBeUndefined()
  // ⚠️ Including the malformed shape. Telling someone to write `provider/model` without being able
  // to name a single provider that exists is a dead end, not a repair.
  expect(Settings.refusal({ model: "sonnet" }, blind)).toBeUndefined()
})

test("🔴 an unresolved catalog does not excuse an unchecked AGENT", () => {
  // The roster is global and the catalog is location-scoped, so a schedule naming no directory has a
  // readable roster and no catalog at all. Half the check still runs — that asymmetry is the point.
  expect(Settings.refusal({ agent: "ghost", model: "spark/anything" }, { ...known, models: undefined }))
    .toContain('No agent named "ghost"')
})
