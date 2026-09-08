import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"

/**
 * AN UNATTRIBUTED CHAT BELONGS TO AN OFFICER — NEVER A POSTURE.
 *
 * Owner, 2026-08-24: *"ensure there are no such ghost officers, and instead the [bar] at the bottom
 * defaults to Nova itself, while the user can only speak with the officers, which are fully
 * responsible for their subagents."*
 *
 * The haunting this removes: `build` was the default, and `POSTURE_IDS` excludes `build` from
 * `isColleague` — so the agent that answered you had no Contacts row, was exempt from
 * one-chat-per-agent, and never got the identity that would title its chat. The chat stayed
 * *"New session"* and the thing you were talking to did not appear to exist.
 */

describe("who owns a chat nobody attributed", () => {
  test("🔴 the default colleague is Nova, and Nova is an officer", () => {
    expect(AgentV2.DEFAULT_COLLEAGUE_ID).toBe(AgentV2.NOVA_ID)
    expect(AgentV2.isColleague({ id: AgentV2.DEFAULT_COLLEAGUE_ID, mode: "primary" })).toBe(true)
  })

  test("🔴 the default is NOT a posture", () => {
    // The control that would have failed before the change: `build` was the default and is a posture.
    expect(AgentV2.POSTURE_IDS.has(AgentV2.DEFAULT_COLLEAGUE_ID)).toBe(false)
    expect(AgentV2.POSTURE_IDS.has(AgentV2.BUILD_ID)).toBe(true)
    expect(AgentV2.isColleague({ id: AgentV2.BUILD_ID, mode: "primary" })).toBe(false)
  })

  test("a posture is still a real agent id — it is not deleted, only un-defaulted", () => {
    // The postures remain: they are permission modes, and existing `build` chats keep working. The
    // change is which one a chat with no colleague named FALLS TO.
    expect(String(AgentV2.BUILD_ID)).toBe("build")
    expect(AgentV2.POSTURE_IDS.has("plan")).toBe(true)
  })

  test("⚠️ `defaultID` still points at the build agent, not at the default officer", () => {
    // The compatibility alias means what its name always meant to `plugin/agent.ts` — "the id of the
    // build agent". Pointing it at Nova instead would have made that plugin configure NOVA with the
    // build system prompt.
    expect(AgentV2.defaultID).toBe(AgentV2.BUILD_ID)
    expect(AgentV2.defaultID).not.toBe(AgentV2.DEFAULT_COLLEAGUE_ID)
  })
})
