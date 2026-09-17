import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "../../permission"
import { ShortChat } from "./short-chat"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("ShortChat policy", () => {
  test("is opt-in and offers no tools", () => {
    expect(ShortChat.enabled(undefined)).toBe(false)
    expect(ShortChat.offered(undefined, "read")).toBe(true)
    for (const name of ["read", "write", "bash", "spawn", "tool_search", "upgrade_chat"])
      expect(ShortChat.offered(true, name), name).toBe(false)
  })

  test("permission rules deny every forged action, including the retired upgrade action", () => {
    const rules = ShortChat.permissionRules(true)
    for (const action of ["read", "write", "bash", "spawn", "configure", "chat_upgrade"])
      expect(PermissionV2.evaluate(action, "*", rules).effect, action).toBe("deny")
    expect(ShortChat.permissionRules(false)).toEqual([])
  })

  test("the runner consumes the policy at every expensive boundary", () => {
    const runner = readFileSync(path.join(import.meta.dir, "llm.ts"), "utf8")
    // The prompt is one `PromptManager` render per epoch; a Chat with no job instructions renders to
    // nothing, which is the "no system prompt at all" case.
    expect(runner).toContain("PromptManager.generate")
    expect(runner).toContain("if (text.length === 0) return SystemContext.empty")
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
