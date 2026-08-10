import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "../../permission"
import { ShortChat } from "./short-chat"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("ShortChat policy", () => {
  test("is opt-in and offers only the consent-bound upgrade tool", () => {
    expect(ShortChat.enabled(undefined)).toBe(false)
    expect(ShortChat.offered(undefined, "read")).toBe(true)
    expect(ShortChat.offered(true, ShortChat.UPGRADE_TOOL)).toBe(true)
    for (const name of ["read", "write", "bash", "spawn", "tool_search"])
      expect(ShortChat.offered(true, name), name).toBe(false)
  })

  test("short prompt contains persona and guidance only", () => {
    expect(ShortChat.systemParts("You are Nova.")).toEqual(["You are Nova.", ShortChat.GUIDANCE])
    expect(ShortChat.systemParts(undefined)).toEqual([ShortChat.GUIDANCE])
  })

  test("permission rules deny forged actions but leave Upgrade as an ask", () => {
    const rules = ShortChat.permissionRules(true)
    for (const action of ["read", "write", "bash", "spawn", "configure"])
      expect(PermissionV2.evaluate(action, "*", rules).effect, action).toBe("deny")
    expect(PermissionV2.evaluate("chat_upgrade", "*", rules).effect).toBe("ask")
    expect(ShortChat.permissionRules(false)).toEqual([])
  })

  test("the runner consumes the policy at every expensive boundary", () => {
    const runner = readFileSync(path.join(import.meta.dir, "llm.ts"), "utf8")
    expect(runner).toContain("? Effect.succeed(SystemContext.empty)")
    expect(runner).toContain("? ShortChat.systemParts(harness.persona)")
    expect(runner).toContain("ShortChat.offered(config.shortChat, name)")
    expect(runner).toContain("const startSnapshot = ShortChat.enabled(config.shortChat)")
    expect(runner).toContain("const endSnapshot = ShortChat.enabled(config.shortChat)")
    expect(runner).toContain("!ShortChat.enabled(handoff.shortChat) && (handoff.quality")
    expect(runner).toContain("if (ShortChat.enabled(driveConfig.shortChat)) break")

    const maintenance = readFileSync(path.join(import.meta.dir, "maintenance.ts"), "utf8")
    expect(maintenance).toContain("config.shortChat === true || config.memory === false")
  })
})
