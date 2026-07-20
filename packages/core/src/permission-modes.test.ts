import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "./permission"
import { MODE_RULES, resolveConfig, EFFECTIVE_CONFIG_DEFAULTS } from "./session/config-resolve"

// 1K pure-logic coverage: mode rule overlays, reply normalization, and reply→saved-rule mapping.

// The build agent's effective baseline (agent.ts defaults): allow-all with external asks.
const agentDefaults = [
  { action: "*", resource: "*", effect: "allow" as const },
  { action: "external_directory_read", resource: "*", effect: "ask" as const },
  { action: "external_directory_write", resource: "*", effect: "ask" as const },
]

const effect = (mode: keyof typeof MODE_RULES, action: string, resource = "src/x.ts") =>
  PermissionV2.evaluate(action, resource, [...agentDefaults, ...MODE_RULES[mode]]).effect

describe("MODE_RULES overlays (1K)", () => {
  test("plan denies the whole mutation cluster", () => {
    for (const action of ["edit", "write", "create", "trash", "external_directory_write"])
      expect(effect("plan", action)).toBe("deny")
    expect(effect("plan", "read")).toBe("allow")
  })

  test("surgical denies only wholesale overwrite", () => {
    expect(effect("surgical", "write")).toBe("deny")
    expect(effect("surgical", "edit")).toBe("allow")
    expect(effect("surgical", "create")).toBe("allow")
  })

  test("ask sends the mutation/exec cluster through consent (never silent with an allow-all baseline)", () => {
    for (const action of ["edit", "write", "create", "trash", "bash"]) expect(effect("ask", action)).toBe("ask")
    expect(effect("ask", "read")).toBe("allow")
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
