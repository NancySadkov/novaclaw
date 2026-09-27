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
 *
 * ⭐ **This file was the FIRST HALF of a fix that took two releases, and the second half is what the
 * last two tests here are about.** 2026-08-24 made Nova the default and left `build` a real agent —
 * which is the state that produced the owner's next message, *"they are not just ghosts polluting
 * NovaClaw"*. A default that is an officer, while the mode is still an agent, is half a fix: the
 * ghost simply stops being the front door and becomes an option instead. 2026-09-27 retired it
 * (`20260927201500_retire_the_anonymous_agents`), so the posture is no longer a thing a chat can run
 * as at all. Both halves are asserted here, because the failure mode is precisely believing you have
 * finished after the first one.
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

  test("🔴 a retired id is a RETIRED id — kept as vocabulary, not as an agent", () => {
    // The set survives the agent, and the distinction is the whole point. `POSTURE_IDS` is the
    // vocabulary nine readers share for "was never a colleague", and a pre-retirement row still
    // carries one; what is gone is anything that could MINT one.
    expect(String(AgentV2.BUILD_ID)).toBe("build")
    expect(AgentV2.POSTURE_IDS.has("plan")).toBe(true)
    // The clause that made the previous release a half-fix, stated as an absence: an id in the
    // retired set is a colleague under no reading of the predicate. It was already true of `build`
    // and the owner still found it in the catalogue — because being excluded from `isColleague` is
    // not the same as not existing, and the roster lists what the plugin declares.
    for (const retired of [AgentV2.BUILD_ID, "plan"])
      expect(AgentV2.isColleague({ id: retired, mode: "primary" }), `${retired} reads as a colleague`).toBe(false)
  })

  test("🔴 no second name for a retired id survives as a default", () => {
    // `AgentV2.defaultID` was a deprecated alias for `BUILD_ID`, kept with the stated reason *"so an
    // out-of-tree caller keeps compiling"*. That is a legacy-compatibility layer, and it pointed at
    // an id whose entire meaning was "the agent a chat ran as when nobody chose" — i.e. the alias
    // named the retirement's whole subject as the thing it was a synonym for. Its only real reader
    // was a test asserting it still equalled `BUILD_ID`, which is a test that pinned the defect.
    //
    // Asserting the export's ABSENCE is the "impossible" rung for the class "a retired identifier
    // kept alive under a second name": the wrong call cannot be written, because the name to write
    // it with is gone.
    expect("defaultID" in AgentV2, "a retired id is aliased again").toBe(false)
  })
})
