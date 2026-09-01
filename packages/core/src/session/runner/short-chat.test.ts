import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { PermissionV2 } from "../../permission"
import { ShortChat } from "./short-chat"
import { SystemCompose } from "./system-compose"
import { readFileSync } from "node:fs"
import path from "node:path"
import { UpgradeChatTool } from "../../tool/upgrade-chat"

describe("ShortChat policy", () => {
  test("is opt-in and offers only the consent-bound upgrade tool", () => {
    expect(ShortChat.enabled(undefined)).toBe(false)
    expect(ShortChat.offered(undefined, "read")).toBe(true)
    expect(ShortChat.offered(undefined, ShortChat.UPGRADE_TOOL)).toBe(false)
    expect(ShortChat.offered(true, ShortChat.UPGRADE_TOOL)).toBe(true)
    for (const name of ["read", "write", "bash", "spawn", "tool_search"])
      expect(ShortChat.offered(true, name), name).toBe(false)
  })

  test("short prompt retains the officer identity and standing job brief", () => {
    const identity = SystemCompose.agentIdentitySection({
      id: "iris",
      name: "Iris",
      title: "Companion",
      personality: "Warm and brief.",
    })
    expect(
      ShortChat.systemParts({ persona: "Be direct.", agentIdentity: identity, agentSystem: "Talk with care." }),
    ).toEqual(["Be direct.", identity, "Talk with care.", ShortChat.GUIDANCE])
    expect(ShortChat.systemParts({ agentIdentity: identity })).toEqual([identity, ShortChat.GUIDANCE])
    expect(identity).toContain("Your name is Iris.")
    expect(identity).toContain("Your job title is Companion.")
    expect(identity).toContain("Warm and brief.")
    expect(ShortChat.GUIDANCE).toContain("MUST call upgrade_chat immediately")
    expect(ShortChat.GUIDANCE).toContain("Do not answer, offer, or describe the upgrade first")
  })

  test("permission rules deny forged actions but leave Upgrade as an ask", () => {
    const rules = ShortChat.permissionRules(true)
    for (const action of ["read", "write", "bash", "spawn", "configure"])
      expect(PermissionV2.evaluate(action, "*", rules).effect, action).toBe("deny")
    expect(PermissionV2.evaluate("chat_upgrade", "*", rules).effect).toBe("ask")
    expect(ShortChat.permissionRules(false)).toEqual([])
  })

  test("the reserved horizon name is backed by the resident Upgrade tool", () => {
    expect(UpgradeChatTool.name).toBe(ShortChat.UPGRADE_TOOL)
    expect(UpgradeChatTool.SUCCESS).toContain("Agent is now enabled")
  })

  test("Upgrade publishes only after approval and an existing session", async () => {
    const order: string[] = []
    const success = await Effect.runPromise(
      UpgradeChatTool.runUpgrade({
        approve: Effect.sync(() => order.push("approved")).pipe(Effect.asVoid),
        exists: Effect.sync(() => (order.push("exists"), true)),
        publish: Effect.sync(() => order.push("published")).pipe(Effect.asVoid),
      }),
    )
    expect(success).toEqual({ upgraded: true, message: UpgradeChatTool.SUCCESS })
    expect(order).toEqual(["approved", "exists", "published"])

    order.length = 0
    const denied = await Effect.runPromiseExit(
      UpgradeChatTool.runUpgrade({
        approve: Effect.fail("declined"),
        exists: Effect.sync(() => (order.push("exists"), true)),
        publish: Effect.sync(() => order.push("published")).pipe(Effect.asVoid),
      }),
    )
    expect(Exit.isFailure(denied)).toBe(true)
    expect(order).toEqual([])
  })

  // The restricted posture and the ordinary one share the identity/job prefix. Only the trailing
  // guidance and tool horizon change.
  test("the Chat posture's identity prompt is byte-identical expressed as blocks", () => {
    const agentIdentity = SystemCompose.agentIdentitySection({ id: "iris", name: "Iris" })
    const agentSystem = "Talk with care."
    for (const persona of ["Be direct.", undefined]) {
      const asBlocks = SystemCompose.composeSystemParts({
        ...(persona === undefined ? {} : { persona }),
        agentIdentity,
        agentSystem,
        base: ShortChat.GUIDANCE,
      })
      expect(asBlocks).toEqual(ShortChat.systemParts({ persona, agentIdentity, agentSystem }))
      expect(asBlocks.indexOf(agentIdentity)).toBeLessThan(asBlocks.indexOf(agentSystem))
    }
  })

  test("the runner consumes the policy at every expensive boundary", () => {
    const runner = readFileSync(path.join(import.meta.dir, "llm.ts"), "utf8")
    expect(runner).toContain("? Effect.succeed(SystemContext.empty)")
    expect(runner).toContain("ShortChat.GUIDANCE")
    expect(runner).toContain("harness.chatPersona")
    expect(runner).toContain("agentIdentity")
    expect(runner).toContain("agentSystem: agent.info?.system")
    expect(runner).toContain("ShortChat.offered(config.shortChat, name)")
    expect(runner).toContain("const startSnapshot = ShortChat.enabled(config.shortChat)")
    expect(runner).toContain("const endSnapshot = ShortChat.enabled(config.shortChat)")
    expect(runner).toContain("!ShortChat.enabled(handoff.shortChat) && (handoff.quality")
    expect(runner).toContain("if (ShortChat.enabled(driveConfig.shortChat)) break")

    // ⚠️ The maintenance gate stopped spelling its own stances on 2026-08-13. `config.shortChat ===
    // true` became `ShortChat.enabled(...)` — the same predicate this file's whole subject is — and
    // the memory half became `stanceOf("memory", ...)`, which reads the fallback off the descriptor
    // instead of carrying a private copy of it. What matters here is unchanged: post-drain
    // extraction is gated on BOTH, before any engine or model work.
    const maintenance = readFileSync(path.join(import.meta.dir, "maintenance.ts"), "utf8")
    expect(maintenance).toContain('ShortChat.enabled(config.shortChat) || !stanceOf("memory", config.memory)')
  })
})
