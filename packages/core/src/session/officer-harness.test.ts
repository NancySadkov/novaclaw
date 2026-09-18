import { describe, expect, test } from "bun:test"
import { OfficerHarness } from "@novaclaw/core/session/officer-harness"

// The officer harness-detail merge: shipped < instance < officer < session,
// `undefined = inherit` at every step. Pure algebra, no DB.

describe("chainDeclared", () => {
  test("the same reference means the chain said nothing — the value IS the officer fold", () => {
    const base = { enabled: true, attempts: 3 }
    expect(OfficerHarness.chainDeclared(base, base)).toBeUndefined()
    expect(OfficerHarness.chainDeclared(undefined, undefined)).toBeUndefined()
  })

  test("a different reference means some layer declared it, even when equal by value", () => {
    // Equal-by-value still counts as declared: merging it field-wise over the officer yields
    // the same answer either way, so there is nothing to distinguish — and nothing to lose.
    expect(OfficerHarness.chainDeclared({ enabled: true }, { enabled: true })).toEqual({ enabled: true })
  })
})

describe("resolveStrict without an officer is the old spread", () => {
  test("instance overlaid with the chain, field for field", () => {
    const instance = { enabled: false, attempts: 1, wallMinutes: 45, verification: true }
    const chain = { enabled: true, wallMinutes: 20 }
    expect(OfficerHarness.resolveStrict(instance, undefined, chain)).toEqual({ ...instance, ...chain })
  })

  test("no chain either is the instance block, unchanged", () => {
    const instance = { enabled: true, attempts: 2 }
    expect(OfficerHarness.resolveStrict(instance, undefined, undefined)).toEqual(instance)
  })
})

describe("resolveStrict", () => {
  test("each field resolves session, then officer, then instance", () => {
    expect(
      OfficerHarness.resolveStrict(
        { enabled: false, attempts: 1, wallMinutes: 45 },
        { enabled: true, attempts: 3 },
        { wallMinutes: 20 },
      ),
    ).toEqual({
      enabled: true,
      verification: undefined,
      recovery: undefined,
      editingAids: undefined,
      budgetSteering: undefined,
      attempts: 3,
      wallMinutes: 20,
      executionTokens: undefined,
      reasoningTokens: undefined,
    })
  })

  test("all absent is all absent — the runner applies shipped defaults, not this module", () => {
    expect(OfficerHarness.resolveStrict(undefined, undefined, undefined)).toEqual({
      enabled: undefined,
      verification: undefined,
      recovery: undefined,
      editingAids: undefined,
      budgetSteering: undefined,
      attempts: undefined,
      wallMinutes: undefined,
      executionTokens: undefined,
      reasoningTokens: undefined,
    })
  })

  test("officer lever groups and budgets survive a chat that only toggles enabled", () => {
    // The defect this merge exists for: the chain fold replaces whole objects, so a
    // chat's `{ enabled: true }` switch used to wipe the officer's standing detail.
    const resolved = OfficerHarness.resolveStrict(
      undefined,
      { enabled: false, verification: false, executionTokens: 16384, reasoningTokens: 0 },
      { enabled: true },
    )
    expect(resolved).toMatchObject({ enabled: true, verification: false, executionTokens: 16384 })
  })
})

describe("affective", () => {
  test("a bare boolean normalizes to the stance and nothing else", () => {
    expect(OfficerHarness.normalizeAffective(true)).toEqual({ enabled: true })
    expect(OfficerHarness.normalizeAffective(false)).toEqual({ enabled: false })
    expect(OfficerHarness.normalizeAffective(undefined)).toEqual({})
  })

  test("the session stance wins for on/off; detail is officer over instance", () => {
    expect(
      OfficerHarness.resolveAffective({ enabled: true, temperature: 0.7, extended: true }, { temperature: 0.4 }, false),
    ).toEqual({ enabled: false, temperature: 0.4, extended: true })
  })

  test("a bare-boolean officer keeps the old shape working", () => {
    expect(OfficerHarness.resolveAffective({ enabled: false, temperature: 0.7 }, true, undefined)).toEqual({
      enabled: true,
      temperature: 0.7,
      extended: false,
    })
  })
})

describe("introspection", () => {
  test("a bare boolean normalizes to the stance and nothing else", () => {
    expect(OfficerHarness.normalizeIntrospection(true)).toEqual({ enabled: true })
    expect(OfficerHarness.normalizeIntrospection(undefined)).toEqual({})
  })

  test("detail resolves officer over instance; absence survives for the runner's defaults", () => {
    expect(
      OfficerHarness.resolveIntrospection(
        { enabled: true, cadence: 3, model: "a/b" },
        { cadence: 5, prompt: "Changed?" },
        undefined,
      ),
    ).toEqual({
      enabled: true,
      cadence: 5,
      model: "a/b",
      prompt: "Changed?",
      interjection: undefined,
      generateInterjection: undefined,
    })
  })

  test("the session stance can switch off an officer that opted in", () => {
    expect(OfficerHarness.resolveIntrospection(undefined, { enabled: true, cadence: 2 }, false).enabled).toBe(false)
  })
})

describe("applyOfficerHorizon", () => {
  const routing = (name: string) => name !== "bash"

  test("no officer layer is the routing table alone", () => {
    const offered = OfficerHarness.applyOfficerHorizon(routing, undefined)
    expect(offered("bash")).toBe(false)
    expect(offered("read")).toBe(true)
  })

  test("an officer false denies; an officer true restores a routing-withdrawn tool", () => {
    const offered = OfficerHarness.applyOfficerHorizon(routing, { read: false, bash: true })
    expect(offered("read")).toBe(false)
    expect(offered("bash")).toBe(true)
  })

  test("configure is never denied — an officer cannot strand its own repair tool", () => {
    const offered = OfficerHarness.applyOfficerHorizon(routing, { configure: false })
    expect(offered("configure")).toBe(true)
  })
})

describe("resolveRecipes", () => {
  const lib = [
    { name: "deploy", description: "Ship it", manual: "run ./ship" },
    { name: "logs", description: "Read logs", manual: "tail" },
  ]

  test("no officer layer is the library alone", () => {
    expect(OfficerHarness.resolveRecipes(lib, undefined).map((recipe) => recipe.name)).toEqual(["deploy", "logs"])
  })

  test("the officer wins by name, including hiding one with enabled: false", () => {
    const resolved = OfficerHarness.resolveRecipes(lib, {
      adhocTools: [
        { name: "logs", description: "Read logs", manual: "tail -f", enabled: false },
        { name: "mine", description: "Officer-only", manual: "run" },
      ],
    })
    expect(resolved.find((recipe) => recipe.name === "logs")).toMatchObject({ manual: "tail -f", enabled: false })
    expect(resolved.some((recipe) => recipe.name === "mine")).toBe(true)
    expect(resolved.some((recipe) => recipe.name === "deploy")).toBe(true)
  })

  test("globalTools: false drops the library without touching the officer's own", () => {
    const resolved = OfficerHarness.resolveRecipes(lib, {
      globalTools: false,
      adhocTools: [{ name: "mine", description: "Officer-only", manual: "run" }],
    })
    expect(resolved.map((recipe) => recipe.name)).toEqual(["mine"])
  })
})
