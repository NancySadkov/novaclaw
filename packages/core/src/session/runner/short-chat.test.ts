import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "../../permission"
import { ShortChat } from "./short-chat"
import { SystemCompose } from "./system-compose"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("ShortChat policy", () => {
  test("is opt-in and offers no tools", () => {
    expect(ShortChat.enabled(undefined)).toBe(false)
    expect(ShortChat.offered(undefined, "read")).toBe(true)
    for (const name of ["read", "write", "bash", "spawn", "tool_search", "upgrade_chat"])
      expect(ShortChat.offered(true, name), name).toBe(false)
  })

  test("the only system part is the visible personality from the officer settings", () => {
    expect(SystemCompose.composeSystemParts({ agentSystem: "Talk with care." })).toEqual(["Talk with care."])
    expect(SystemCompose.composeSystemParts({})).toEqual([])
  })

  test("permission rules deny every forged action, including the retired upgrade action", () => {
    const rules = ShortChat.permissionRules(true)
    for (const action of ["read", "write", "bash", "spawn", "configure", "chat_upgrade"])
      expect(PermissionV2.evaluate(action, "*", rules).effect, action).toBe("deny")
    expect(ShortChat.permissionRules(false)).toEqual([])
  })

  test("the runner consumes the policy at every expensive boundary", () => {
    const runner = readFileSync(path.join(import.meta.dir, "llm.ts"), "utf8")
    expect(runner).toContain("? Effect.succeed(SystemContext.empty)")
    expect(runner).toContain("agentSystem: prototypeBrief ?? agent.info?.personality")
    expect(runner).not.toContain("ShortChat.GUIDANCE")
    expect(runner).toContain("ShortChat.offered(config.shortChat, name)")
    expect(runner).toContain("const startSnapshot = ShortChat.enabled(config.shortChat)")
    expect(runner).toContain("const endSnapshot = ShortChat.enabled(config.shortChat)")
    expect(runner).toContain("!ShortChat.enabled(handoff.shortChat) && (handoff.quality")
    expect(runner).toContain("if (ShortChat.enabled(driveConfig.shortChat)) break")

    const maintenance = readFileSync(path.join(import.meta.dir, "maintenance.ts"), "utf8")
    expect(maintenance).toContain('ShortChat.enabled(config.shortChat) || !stanceOf("memory", config.memory)')
  })
})
