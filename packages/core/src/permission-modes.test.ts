import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "./permission"
import { ASK_BEFORE_CHANGES_RULES, MODE_RULES, resolveConfig, EFFECTIVE_CONFIG_DEFAULTS } from "./session/config-resolve"

// 1K pure-logic coverage: mode rule overlays, reply normalization, and reply→saved-rule mapping.

// The build agent's effective baseline (agent.ts defaults): allow-all with external asks.
const agentDefaults = [
  { action: "*", resource: "*", effect: "allow" as const },
  { action: "external_directory_read", resource: "*", effect: "ask" as const },
  { action: "external_directory_write", resource: "*", effect: "ask" as const },
]

const effect = (mode: keyof typeof MODE_RULES, action: string, resource = "src/x.ts") =>
  PermissionV2.evaluate(action, resource, [...agentDefaults, ...MODE_RULES[mode]]).effect

// The HARD-ARM predicate, replicated exactly from permission.ts's `denied()` (a closure, so it
// cannot be imported). The evaluator checks the mode overlay IN ISOLATION — before the configured
// rules, before the read baseline, and before any saved answer — and returns deny outright if it
// bites (`if (denied(input, configuredRules) || denied(input, modeRules) || …)`). That early arm is
// what makes a mode deny un-softenable, so this is the predicate a mode-deny test must assert.
const modeDenies = (mode: keyof typeof MODE_RULES, action: string, resource: string) =>
  PermissionV2.evaluate(action, resource, MODE_RULES[mode]).effect === "deny"

describe("MODE_RULES overlays (1K)", () => {
  test("plan (Analyze) denies the whole mutation cluster AND arbitrary execution", () => {
    for (const action of ["edit", "write", "create", "trash", "external_directory_write"])
      expect(effect("plan", action)).toBe("deny")
    // The mode's own UI copy is "Read only", so execution has to go too: `bash` runs anything the
    // host can run and `js` evaluates code. Both were permitted outright before this rule existed.
    expect(effect("plan", "bash", "rm -rf /")).toBe("deny")
    expect(effect("plan", "bash", "ls")).toBe("deny")
    expect(effect("plan", "js", "process.exit(0)")).toBe("deny")
    // ...while actually reading — the whole point of the mode — is untouched.
    expect(effect("plan", "read")).toBe("allow")
    expect(effect("plan", "explore")).toBe("allow")
  })

  test("NEGATIVE CONTROL: strip the execution rules and Analyze permits `rm -rf` again", () => {
    // Proves the assertions above bite because of MODE_RULES.plan and nothing else. If someone
    // deletes the bash/js denies, the test above goes red — and this one stays green, naming why.
    const preFix = MODE_RULES.plan.filter((rule) => rule.action !== "bash" && rule.action !== "js")
    expect(PermissionV2.evaluate("bash", "rm -rf /", [...agentDefaults, ...preFix]).effect).toBe("allow")
    expect(PermissionV2.evaluate("js", "1+1", [...agentDefaults, ...preFix]).effect).toBe("allow")
    // ...and the hard arm never trips either, so there was nothing to soften in the first place.
    expect(PermissionV2.evaluate("bash", "rm -rf /", preFix).effect).not.toBe("deny")
  })

  test("plan (Analyze) denies the two mutations that hid behind a non-file action name", () => {
    // Neither is spelled `write` or `bash`, so both reached the baseline's `* → allow`.
    // `provision` (quality_provision) runs MODEL-SUPPLIED command strings through the agent shell
    // and then persists them to the instance settings store; `revert` overwrites working-tree files
    // from a git snapshot. Assert the HARD arm too, not just the full stack — a deny a saved
    // allow-always could soften is not a deny (see the `modeDenies` note above).
    expect(effect("plan", "provision", "test: bun test")).toBe("deny")
    expect(effect("plan", "revert", "src/x.ts")).toBe("deny")
    expect(modeDenies("plan", "provision", "test: rm -rf /")).toBe(true)
    expect(modeDenies("plan", "revert", "src/x.ts")).toBe(true)
    // ...and this is a POSTURE rule, not a retirement: Build still does both freely.
    expect(effect("bypass", "provision", "test: bun test")).toBe("allow")
    expect(effect("bypass", "revert", "src/x.ts")).toBe("allow")
  })

  test("NEGATIVE CONTROL: strip those two rules and Analyze permits provision/revert again", () => {
    const preFix = MODE_RULES.plan.filter((rule) => rule.action !== "provision" && rule.action !== "revert")
    expect(PermissionV2.evaluate("provision", "test: rm -rf /", [...agentDefaults, ...preFix]).effect).toBe("allow")
    expect(PermissionV2.evaluate("revert", "src/x.ts", [...agentDefaults, ...preFix]).effect).toBe("allow")
    // ...and the hard arm never trips either, so there was nothing to soften in the first place.
    expect(PermissionV2.evaluate("provision", "test: rm -rf /", preFix).effect).not.toBe("deny")
    expect(PermissionV2.evaluate("revert", "src/x.ts", preFix).effect).not.toBe("deny")
  })

  test("the ad-hoc-tool hole: a mode overlay cannot reach an action it never named", () => {
    // This test asserts a LIMIT, not a guarantee — it is green because the hole is open. MODE_RULES
    // enumerates action names ahead of time, but an agent-defined ad-hoc tool (`tool/define-tool.ts`)
    // asserts under its OWN name, chosen by the model at runtime, so the baseline's catch-all
    // `* → allow` answers for it in EVERY mode, Analyze included. No row added above can ever cover
    // it; only inverting the baseline to an explicit allowlist can (v0.2.0 B4c). It lives here so a
    // reader MEETS the hole instead of inferring from the denies that a mode is sealed.
    // ⚠️ When B4c lands this test should go RED. That is the signal it worked — retire it then.
    const adHoc = "my_deploy_tool" // whatever the model decided to call it
    for (const mode of ["plan", "ask", "surgical", "bypass", "yolo"] as const) {
      expect(effect(mode, adHoc)).toBe("allow")
      expect(modeDenies(mode, adHoc, "anything")).toBe(false)
    }
  })

  test("a saved allow-always CANNOT soften Analyze's execution deny (mode denies are HARD)", () => {
    // What "always allow bash" persists. Saved rules land LAST, so by last-match-wins alone they
    // would hand the command straight back — which is exactly why the mode overlay is also checked
    // on its own, up front, before saved answers are ever consulted.
    const savedAllowAlways = { action: "bash", resource: "*", effect: "allow" as const }
    const all = [...agentDefaults, ...MODE_RULES.plan, savedAllowAlways]
    expect(PermissionV2.evaluate("bash", "rm -rf /", all).effect).toBe("allow") // ordering alone: NOT enough
    expect(modeDenies("plan", "bash", "rm -rf /")).toBe(true) // the hard arm: denies regardless
    expect(modeDenies("plan", "js", "process.exit(0)")).toBe(true)
    // Contrast, so this asserts something: under `ask` the same saved answer is SUPPOSED to win,
    // and no hard arm trips (the existing quiets-consent test below is the other half of that).
    expect(modeDenies("ask", "bash", "ls")).toBe(false)
  })

  test("surgical denies only wholesale overwrite — and deliberately still permits execution", () => {
    expect(effect("surgical", "write")).toBe("deny")
    expect(effect("surgical", "edit")).toBe("allow")
    expect(effect("surgical", "create")).toBe("allow")
    // Pinned on purpose (see the note on MODE_RULES.surgical): surgical constrains the SHAPE of a
    // write, never the posture, and it is now the Tuning switch "Edits instead of overwriting" —
    // whose feature rule is this same lone `write` deny. An execution deny here would make the mode
    // and the switch disagree. Changing this line means changing the switch in permission.ts too.
    expect(effect("surgical", "bash", "ls")).toBe("allow")
    expect(effect("surgical", "js", "1+1")).toBe("allow")
  })

  test("ask sends the mutation/exec cluster through consent (never silent with an allow-all baseline)", () => {
    for (const action of ["edit", "write", "create", "trash", "bash"]) expect(effect("ask", action)).toBe("ask")
    expect(effect("ask", "read")).toBe("allow")
  })

  test("the `ask` MODE and the askBeforeChanges SWITCH are one list, not two copies of one", () => {
    // They were two byte-identical literals — `MODE_RULES.ask` here and an inline array in
    // permission.ts's `featureRules` — with nothing but adjacency claiming they agreed. The switch
    // IS what the mode became (same story as surgical → "Edits instead of overwriting"), so a row
    // added to one and not the other forks one promise into two behaviours, silently and green.
    // Identity, not deep-equality: only `toBe` can tell "the same list" from "a copy that happens
    // to match today", and the copy is the failure mode.
    expect(MODE_RULES.ask).toBe(ASK_BEFORE_CHANGES_RULES)
    // NEGATIVE CONTROL: a structurally identical copy — precisely what shipped — passes every
    // equality check and fails this one. That is the whole reason the assertion above is `toBe`.
    const copy = [...ASK_BEFORE_CHANGES_RULES]
    expect(copy).toEqual([...MODE_RULES.ask])
    expect(MODE_RULES.ask).not.toBe(copy)
    // And the list still says what the i18n copy promises: consent for the mutation cluster AND
    // for execution ("…and before it runs a shell command"). `bash` is that row.
    expect([...ASK_BEFORE_CHANGES_RULES].map((rule) => rule.action).sort()).toEqual([
      "bash",
      "create",
      "edit",
      "trash",
      "write",
    ])
    expect(ASK_BEFORE_CHANGES_RULES.every((rule) => rule.effect === "ask" && rule.resource === "*")).toBe(true)
  })

  test("a saved allow-always quiets ask-mode consent (saved rules land after the overlay)", () => {
    const all = [
      ...agentDefaults,
      ...MODE_RULES.ask,
      { action: "write", resource: "*", effect: "allow" as const }, // saved allow-always
    ]
    expect(PermissionV2.evaluate("write", "src/x.ts", all).effect).toBe("allow")
    expect(PermissionV2.evaluate("bash", "ls", all).effect).toBe("ask")
  })

  test("bypass allows in-project mutations but external still asks", () => {
    expect(effect("bypass", "write")).toBe("allow")
    expect(effect("bypass", "external_directory_write")).toBe("ask")
  })

  test("yolo also opens the external classes", () => {
    expect(effect("yolo", "external_directory_write")).toBe("allow")
    expect(effect("yolo", "external_directory_read")).toBe("allow")
  })

  test("mode overlays never touch non-file agent gating (question stays denied)", () => {
    const rules = [
      ...agentDefaults,
      { action: "question", resource: "*", effect: "deny" as const },
      ...MODE_RULES.yolo,
    ]
    expect(PermissionV2.evaluate("question", "*", rules).effect).toBe("deny")
  })

  test("mode narrowing: a spawned child cannot escalate past its parent", () => {
    const resolved = resolveConfig(EFFECTIVE_CONFIG_DEFAULTS, [
      { permissionMode: "surgical" },
      { permissionMode: "yolo" }, // child asks for yolo — clamped
    ])
    expect(resolved.permissionMode).toBe("surgical")
  })
})

describe("normalizeReply + savedResources (1K six replies)", () => {
  test("legacy trio maps onto verdict-scope", () => {
    expect(PermissionV2.normalizeReply("once")).toEqual({ verdict: "allow", scope: "once" })
    expect(PermissionV2.normalizeReply("always")).toEqual({ verdict: "allow", scope: "always" })
    expect(PermissionV2.normalizeReply("reject")).toEqual({ verdict: "deny", scope: "once" })
  })

  test("the six explicit forms round-trip", () => {
    expect(PermissionV2.normalizeReply("allow-file")).toEqual({ verdict: "allow", scope: "file" })
    expect(PermissionV2.normalizeReply("deny-file")).toEqual({ verdict: "deny", scope: "file" })
    expect(PermissionV2.normalizeReply("deny-always")).toEqual({ verdict: "deny", scope: "always" })
  })

  test("file scope persists the request's CONCRETE resources; always persists the save patterns", () => {
    const request = { resources: ["src/a.ts"], save: ["*"] }
    expect(PermissionV2.savedResources(request, "once")).toEqual([])
    expect(PermissionV2.savedResources(request, "file")).toEqual(["src/a.ts"])
    expect(PermissionV2.savedResources(request, "always")).toEqual(["*"])
  })

  test("a persisted DENY beats a broad allow at evaluation (saved rules last)", () => {
    const all = [
      ...agentDefaults,
      { action: "bash", resource: "rm *", effect: "deny" as const }, // saved deny-file
    ]
    expect(PermissionV2.evaluate("bash", "rm -rf /", all).effect).toBe("deny")
    expect(PermissionV2.evaluate("bash", "ls", all).effect).toBe("allow")
  })
})
