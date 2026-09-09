import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { ShortChat } from "../src/session/runner/short-chat"

// 🔴 The class Xenia shipped in: an AGENTIC harness intervention firing at a session with no tool
// horizon. Pure Chat (`shortChat`) withdraws every tool (`ShortChat.offered`), so a steer that says
// "issue that tool call now" demands a mechanism the model cannot have. Measured on Xenia's chat:
// an ordinary reply ending "Let me check that." matched the announced-tool heuristic and drew
// `ANNOUNCED_TOOL_RECOVERY` — a nudge that can only confuse, because the horizon it points at is
// empty by construction.
//
// The fix gates the four reachable tool-flavored interventions in `runner/llm.ts`:
// the announced-tool arm and the textual-call arm on `toolHorizon` (the provider-local fact of what
// THIS turn was offered), the QE-A provision nudge and the empty-turn wording on the shortChat
// stance. The rest of the nudge machinery is unreachable for a tool-less session by construction
// (doom-loop/failure-streak/reground/children all key on tool calls; the set drive is retired; the
// self-drive already breaks on shortChat) — the premises of THAT claim are pinned behaviorally
// below, and the gates themselves by source assertion, the same rung `agent-pure-chat-boundary.test.ts`
// uses: a ratchet that fails on the next instance, not a comment hoping the next author reads.

const source = (relative: string) => readFileSync(path.join(import.meta.dir, relative), "utf8")

describe("the premise: a pure Chat session has no tool horizon", () => {
  test("every tool name is withdrawn under shortChat — the offeredTools gate cannot rot silently", () => {
    // If a future change ever OFFERS a tool to shortChat, this fails loudly and the nudges'
    // `offeredTools.length > 0` gate — not this test's source text — becomes the live question.
    for (const name of ["bash", "read", "write", "edit", "glob", "grep", "spawn", "colleague", "kb", "self"])
      expect(ShortChat.offered(true, name)).toBe(false)
    // And the mechanical floor denies everything, so even a discovered tool cannot be invoked.
    expect(ShortChat.permissionRules(true)).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    // Sanity: the stance is opt-in — an agent's turn without it keeps its tools.
    expect(ShortChat.offered(undefined, "bash")).toBe(true)
    expect(ShortChat.offered(false, "bash")).toBe(true)
  })
})

describe("the gates: no tool-call nudge reaches a tool-less turn", () => {
  const runner = source("../src/session/runner/llm.ts")

  test("the announced-tool recovery is gated on the turn's tool horizon", () => {
    // The arm Xenia hit. `offeredTools` is the exact list this provider turn received; an
    // un-gated `announcedToolButCalledNone(context)` must not come back.
    expect(runner).toContain("const finishAnnounced = toolHorizon && announcedToolButCalledNone(context)")
    expect(runner).toContain("const toolHorizon = result.offeredTools.length > 0")
  })

  test("the textual-call recovery is gated on the same fact", () => {
    // `TextualCall.detect` fires its json-fence / literal-tag / repeated-block / prose cues without
    // consulting the offered list, so the arm itself must carry the gate.
    expect(runner).toContain("if (!textualNudged && toolHorizon) {")
  })

  test("the QE-A provision nudge respects shortChat, as qualityOn already did", () => {
    expect(runner).toContain(
      "!ShortChat.enabled(handoff.shortChat) &&\n        (handoff.quality ?? entryHarness.quality.enabled) &&",
    )
  })

  test("an empty pure-Chat turn recovers WITHOUT tool wording", () => {
    // The stall recovery itself stays (the user is owed the answer); only the tool clause goes.
    expect(runner).toContain("EMPTY_TURN_RECOVERY_CHAT")
    expect(runner).toContain("? EMPTY_TURN_RECOVERY_CHAT")
    const doomLoop = source("../src/session/runner/doom-loop.ts")
    expect(doomLoop).toContain("export const EMPTY_TURN_RECOVERY_CHAT =")
    // The chat wording itself names no tool.
    const chatLine = /export const EMPTY_TURN_RECOVERY_CHAT =\s*\n?\s*"([^"]+)"/.exec(doomLoop)?.[1] ?? ""
    expect(chatLine).toContain("no reply")
    expect(chatLine.toLowerCase()).not.toContain("tool")
  })
})
