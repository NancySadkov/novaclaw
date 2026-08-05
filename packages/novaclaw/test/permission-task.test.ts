import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Permission } from "../src/permission"
import { Config } from "@/config/config"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Config.node))

const load = Config.use.get()

describe("Permission.evaluate for permission.task", () => {
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionRuleset.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "task",
      pattern,
      action,
    }))

  test("returns ask when no match (default)", () => {
    expect(Permission.evaluate("task", "code-reviewer", []).action).toBe("ask")
  })

  test("returns deny for explicit deny", () => {
    const ruleset = createRuleset({ "code-reviewer": "deny" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
  })

  test("returns allow for explicit allow", () => {
    const ruleset = createRuleset({ "code-reviewer": "allow" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
  })

  test("returns ask for explicit ask", () => {
    const ruleset = createRuleset({ "code-reviewer": "ask" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with deny", () => {
    const ruleset = createRuleset({ "orchestrator-*": "deny" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "general", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with allow", () => {
    const ruleset = createRuleset({ "orchestrator-*": "allow" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("allow")
  })

  test("matches wildcard patterns with ask", () => {
    const ruleset = createRuleset({ "orchestrator-*": "ask" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("ask")
    const globalRuleset = createRuleset({ "*": "ask" })
    expect(Permission.evaluate("task", "code-reviewer", globalRuleset).action).toBe("ask")
  })

  test("later rules take precedence (last match wins)", () => {
    const ruleset = createRuleset({
      "orchestrator-*": "deny",
      "orchestrator-fast": "allow",
    })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("deny")
  })

  test("matches global wildcard", () => {
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "allow" })).action).toBe("allow")
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "deny" })).action).toBe("deny")
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "ask" })).action).toBe("ask")
  })
})

// The `Permission.disabled` block that stood here was DELETED 2026-08-06 with the function. It did
// not test the task tool — it tested `disabled` itself, using the task tool as its example input.
// What governs whether a tool reaches the model is `ToolRegistry`'s availability predicate; what
// governs whether a call is allowed is `Permission.evaluate`, covered above.
describe("permission.task with real config files", () => {
  it.instance(
    "loads task permissions from novaclaw.json config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = (config.permissions ?? []).map((r) => ({
          permission: r.action,
          pattern: r.resource,
          action: r.effect,
        }))
        // general and orchestrator-fast should be allowed, code-reviewer denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permissions: [
          { action: "task", resource: "*", effect: "allow" },
          { action: "task", resource: "code-reviewer", effect: "deny" },
        ],
      },
    },
  )

  it.instance(
    "loads task permissions with wildcard patterns from config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = (config.permissions ?? []).map((r) => ({
          permission: r.action,
          pattern: r.resource,
          action: r.effect,
        }))
        // general and code-reviewer should be ask, orchestrator-* denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("ask")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("ask")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permissions: [
          { action: "task", resource: "*", effect: "ask" },
          { action: "task", resource: "orchestrator-*", effect: "deny" },
        ],
      },
    },
  )

  it.instance(
    "evaluate respects task permission from config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = (config.permissions ?? []).map((r) => ({
          permission: r.action,
          pattern: r.resource,
          action: r.effect,
        }))
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
        // Unspecified agents default to "ask"
        expect(Permission.evaluate("task", "unknown-agent", ruleset).action).toBe("ask")
      }),
    {
      git: true,
      config: {
        permissions: [
          { action: "task", resource: "general", effect: "allow" },
          { action: "task", resource: "code-reviewer", effect: "deny" },
        ],
      },
    },
  )

  it.instance(
    "mixed permission config with task and other tools",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = (config.permissions ?? []).map((r) => ({
          permission: r.action,
          pattern: r.resource,
          action: r.effect,
        }))

        // Verify task permissions
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")

        // Verify other tool permissions
        expect(Permission.evaluate("bash", "*", ruleset).action).toBe("allow")
        expect(Permission.evaluate("edit", "*", ruleset).action).toBe("ask")

      }),
    {
      git: true,
      config: {
        permissions: [
          { action: "bash", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "ask" },
          { action: "task", resource: "*", effect: "deny" },
          { action: "task", resource: "general", effect: "allow" },
        ],
      },
    },
  )

  it.instance(
    "task tool disabled when global deny comes last in config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = (config.permissions ?? []).map((r) => ({
          permission: r.action,
          pattern: r.resource,
          action: r.effect,
        }))

        // Last matching rule wins - "*" deny is last, so all agents are denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "unknown", ruleset).action).toBe("deny")

      }),
    {
      git: true,
      config: {
        permissions: [
          { action: "task", resource: "general", effect: "allow" },
          { action: "task", resource: "code-reviewer", effect: "allow" },
          { action: "task", resource: "*", effect: "deny" },
        ],
      },
    },
  )

  it.instance(
    "task tool NOT disabled when specific allow comes last in config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = (config.permissions ?? []).map((r) => ({
          permission: r.action,
          pattern: r.resource,
          action: r.effect,
        }))

        // Evaluate uses findLast - "general" allow comes after "*" deny
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        // Other agents still denied by the earlier "*" deny
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")

      }),
    {
      git: true,
      config: {
        permissions: [
          { action: "task", resource: "*", effect: "deny" },
          { action: "task", resource: "general", effect: "allow" },
        ],
      },
    },
  )
})
