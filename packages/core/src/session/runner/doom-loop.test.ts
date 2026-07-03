import { describe, expect, test } from "bun:test"
import { SessionInput } from "../input"
import type { SessionMessage } from "../message"
import {
  detectDoomLoop,
  redirectMessage,
  DOOM_LOOP_THRESHOLD,
  toolTargetKey,
  detectFailureStreak,
  failureStreakMessage,
  detectRunaway,
  runawayMessage,
  toolCallsSinceLastUser,
  isEmptyAssistantTurn,
  lastAssistantText,
  containsUnverified,
  shouldReground,
  FAILURE_STREAK_THRESHOLD,
  RUNAWAY_THRESHOLD,
  REGROUND_TOOL_CALLS,
  REGROUND_NUDGE,
} from "./doom-loop"

const call = (name: string, input: string) => ({ name, input })
const fail = (name: string, input: string, failed = true) => ({ name, input, failed })

// Minimal projected-history fixtures — the helpers only read the fields modeled here.
const userMsg = (text: string) => ({ type: "user", text }) as unknown as SessionMessage.Message
const steerMsg = (text: string) =>
  ({ type: "user", text: SessionInput.applySteerProvenance(text) }) as unknown as SessionMessage.Message
const toolPart = (name: string, input: Record<string, unknown>, failed: boolean) => ({
  type: "tool",
  name,
  state: { status: failed ? "error" : "completed", input },
})
const assistantMsg = (
  parts: ReadonlyArray<Record<string, unknown>>,
  error?: { message: string },
) => ({ type: "assistant", content: parts, ...(error ? { error } : {}) }) as unknown as SessionMessage.Message
const textPart = (text: string) => ({ type: "text", text })
const reasoningPart = (text: string) => ({ type: "reasoning", text })

describe("detectDoomLoop", () => {
  test("three identical consecutive calls trips it", () => {
    const c = call("bash", '{"command":"gcc x.c"}')
    expect(detectDoomLoop([c, c, c])).toEqual(c)
  })

  test("fewer than threshold does not trip", () => {
    const c = call("bash", '{"command":"gcc x.c"}')
    expect(detectDoomLoop([c, c])).toBeUndefined()
  })

  test("only the LAST threshold calls matter (recovers then loops)", () => {
    const a = call("read", '{"path":"a"}')
    const b = call("bash", '{"command":"make"}')
    expect(detectDoomLoop([a, b, b, b])).toEqual(b)
  })

  test("different args break the loop", () => {
    expect(
      detectDoomLoop([call("bash", '{"command":"a"}'), call("bash", '{"command":"b"}'), call("bash", '{"command":"a"}')]),
    ).toBeUndefined()
  })

  test("same args but different tool is not a loop", () => {
    expect(detectDoomLoop([call("read", "{}"), call("write", "{}"), call("read", "{}")])).toBeUndefined()
  })

  test("custom threshold of 2", () => {
    const c = call("glob", '{"pattern":"*.ts"}')
    expect(detectDoomLoop([c, c], 2)).toEqual(c)
  })

  test("trailing recent window after a long non-looping history", () => {
    const noise = Array.from({ length: 10 }, (_, i) => call("read", `{"path":"${i}"}`))
    const c = call("bash", '{"command":"loop"}')
    expect(detectDoomLoop([...noise, c, c, c])).toEqual(c)
  })
})

describe("redirectMessage", () => {
  test("names the offending tool and threshold and says stop", () => {
    const msg = redirectMessage(call("bash", "{}"))
    expect(msg).toContain("`bash`")
    expect(msg).toContain(String(DOOM_LOOP_THRESHOLD))
    expect(msg.toLowerCase()).toContain("loop")
  })
})

describe("toolTargetKey", () => {
  test("file tools key on path, ignoring other args", () => {
    expect(toolTargetKey("edit", '{"path":"src/a.ts","oldString":"x","newString":"y"}')).toBe(
      toolTargetKey("edit", '{"path":"src/a.ts","oldString":"p","newString":"q"}'),
    )
  })

  test("bash keys on the first line of the command", () => {
    expect(toolTargetKey("bash", '{"command":"make\\nmore"}')).toBe(toolTargetKey("bash", '{"command":"make\\nother"}'))
    expect(toolTargetKey("bash", '{"command":"make"}')).not.toBe(toolTargetKey("bash", '{"command":"gcc x.c"}'))
  })

  test("glob/grep key on pattern, not the surrounding path", () => {
    expect(toolTargetKey("grep", '{"pattern":"foo","path":"a"}')).toBe(toolTargetKey("grep", '{"pattern":"foo","path":"b"}'))
  })

  test("different tools with the same path are different targets", () => {
    expect(toolTargetKey("read", '{"path":"x"}')).not.toBe(toolTargetKey("write", '{"path":"x"}'))
  })

  test("unparseable input falls back to raw args, still keyed by tool", () => {
    expect(toolTargetKey("bash", "not json")).toBe(toolTargetKey("bash", "not json"))
    expect(toolTargetKey("bash", "not json")).not.toBe(toolTargetKey("read", "not json"))
  })
})

describe("detectFailureStreak", () => {
  test("five same-target failures trips it", () => {
    const calls = Array.from({ length: 5 }, () => fail("bash", '{"command":"gcc x.c"}'))
    const streak = detectFailureStreak(calls)
    expect(streak?.count).toBe(5)
    expect(streak?.name).toBe("bash")
  })

  test("cosmetic arg rewording still trips (the whole point of A2)", () => {
    // Same file, different content each retry — the exact-repeat detector would miss this.
    const calls = Array.from({ length: 6 }, (_, i) => fail("write", `{"path":"out.txt","content":"v${i}"}`))
    expect(detectFailureStreak(calls)?.count).toBe(6)
    expect(detectDoomLoop(calls.map(({ name, input }) => ({ name, input })))).toBeUndefined()
  })

  test("a success breaks the streak", () => {
    const calls = [
      fail("bash", '{"command":"make"}'),
      fail("bash", '{"command":"make"}'),
      fail("bash", '{"command":"make"}', false),
      fail("bash", '{"command":"make"}'),
      fail("bash", '{"command":"make"}'),
    ]
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("a different target breaks the streak", () => {
    const calls = [
      ...Array.from({ length: 4 }, () => fail("read", '{"path":"a"}')),
      fail("read", '{"path":"b"}'),
    ]
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("fewer than threshold does not trip", () => {
    const calls = Array.from({ length: 4 }, () => fail("read", '{"path":"a"}'))
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("newest call must be a failure", () => {
    const calls = [
      ...Array.from({ length: 5 }, () => fail("read", '{"path":"a"}')),
      fail("read", '{"path":"a"}', false),
    ]
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("only the trailing same-target run counts (recovers then loops)", () => {
    const calls = [
      fail("glob", '{"pattern":"*.md"}', false),
      ...Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => fail("bash", '{"command":"loop"}')),
    ]
    expect(detectFailureStreak(calls)?.name).toBe("bash")
  })
})

describe("failureStreakMessage", () => {
  test("names count, tool, and target and says stop repeating", () => {
    const msg = failureStreakMessage({ name: "bash", target: "gcc x.c", count: 5 })
    expect(msg).toContain("5")
    expect(msg).toContain("`bash`")
    expect(msg).toContain("gcc x.c")
    expect(msg.toLowerCase()).toContain("stop repeating")
  })
})

describe("detectRunaway", () => {
  test("trips at the threshold with >=", () => {
    expect(detectRunaway(RUNAWAY_THRESHOLD - 1)).toBe(false)
    expect(detectRunaway(RUNAWAY_THRESHOLD)).toBe(true)
    expect(detectRunaway(RUNAWAY_THRESHOLD + 3)).toBe(true)
  })

  test("message is self-assessment, never a bare 'stop'", () => {
    const msg = runawayMessage(80)
    expect(msg).toContain("80")
    expect(msg.toLowerCase()).toContain("if you're still making real progress")
    expect(msg.toLowerCase()).not.toMatch(/^stop\b/)
  })
})

describe("toolCallsSinceLastUser", () => {
  test("scopes to calls after the last real user message", () => {
    const context = [
      userMsg("first task"),
      assistantMsg([toolPart("read", { path: "a" }, false)]),
      userMsg("second task"),
      assistantMsg([toolPart("bash", { command: "make" }, true), toolPart("bash", { command: "make" }, true)]),
    ]
    const calls = toolCallsSinceLastUser(context)
    expect(calls.length).toBe(2)
    expect(calls.every((c) => c.name === "bash" && c.failed)).toBe(true)
  })

  test("a harness steer does NOT reset the window (the A2 regression)", () => {
    // Without the steer-prefix check, the doom-loop's own nudge would wipe the very streak
    // it fired for — the streak/runaway counters must survive harness interjections.
    const context = [
      userMsg("do the thing"),
      assistantMsg([toolPart("bash", { command: "make" }, true)]),
      steerMsg("Stop repeating that call."),
      assistantMsg([toolPart("bash", { command: "make" }, true)]),
    ]
    expect(toolCallsSinceLastUser(context).length).toBe(2)
  })

  test("a REAL user message resets the window even after steers", () => {
    const context = [
      userMsg("old goal"),
      assistantMsg([toolPart("bash", { command: "make" }, true)]),
      steerMsg("nudge"),
      userMsg("new goal"),
      assistantMsg([toolPart("read", { path: "x" }, false)]),
    ]
    const calls = toolCallsSinceLastUser(context)
    expect(calls.length).toBe(1)
    expect(calls[0]!.name).toBe("read")
  })

  test("classifies error-status parts as failures, completed as successes", () => {
    const context = [
      userMsg("go"),
      assistantMsg([toolPart("edit", { path: "f" }, true), toolPart("edit", { path: "f" }, false)]),
    ]
    const calls = toolCallsSinceLastUser(context)
    expect(calls.map((c) => c.failed)).toEqual([true, false])
  })
})

describe("finish re-grounding (2E/A7)", () => {
  test("fires for a substantial turn ending with a confident summary", () => {
    expect(shouldReground("All done, everything works.", REGROUND_TOOL_CALLS)).toBe(true)
    expect(shouldReground("All done.", REGROUND_TOOL_CALLS + 5)).toBe(true)
  })

  test("does not fire under the threshold (small turns aren't re-ground)", () => {
    expect(shouldReground("Done.", REGROUND_TOOL_CALLS - 1)).toBe(false)
  })

  test("the honesty exemption: an admitted unverified gap stands", () => {
    expect(shouldReground("It should work. unverified: browser runtime — no browser here.", 20)).toBe(false)
    expect(shouldReground("UNVERIFIED: could not run the tests", 20)).toBe(false)
  })

  test("no text (the A3 empty case) is not re-ground territory", () => {
    expect(shouldReground("", 20)).toBe(false)
  })

  test("the nudge orders real checks and forbids manufactured proof", () => {
    expect(REGROUND_NUDGE).toContain("acceptance criteria")
    expect(REGROUND_NUDGE).toContain("unverified:")
    expect(REGROUND_NUDGE.toLowerCase()).toContain("never dress up a static check")
  })

  test("lastAssistantText reads the newest assistant's visible text only", () => {
    const context = [
      userMsg("go"),
      assistantMsg([textPart("old reply")]),
      userMsg("more"),
      assistantMsg([reasoningPart("hidden thinking"), textPart("final "), textPart("answer")]),
    ]
    expect(lastAssistantText(context)).toBe("final \nanswer")
    expect(lastAssistantText([userMsg("nothing yet")])).toBe("")
  })

  test("containsUnverified is case-insensitive and substring-tolerant", () => {
    expect(containsUnverified("note: Unverified claim")).toBe(true)
    expect(containsUnverified("all verified")).toBe(false)
  })
})

describe("isEmptyAssistantTurn", () => {
  test("no text and no tool call is empty (reasoning does not count)", () => {
    expect(isEmptyAssistantTurn([userMsg("go"), assistantMsg([reasoningPart("thinking about tools…")])])).toBe(true)
    expect(isEmptyAssistantTurn([userMsg("go"), assistantMsg([])])).toBe(true)
  })

  test("whitespace-only text is still empty", () => {
    expect(isEmptyAssistantTurn([userMsg("go"), assistantMsg([textPart("  \n ")])])).toBe(true)
  })

  test("real text is not empty", () => {
    expect(isEmptyAssistantTurn([userMsg("go"), assistantMsg([textPart("done.")])])).toBe(false)
  })

  test("a tool call is not empty", () => {
    expect(isEmptyAssistantTurn([userMsg("go"), assistantMsg([toolPart("read", { path: "a" }, false)])])).toBe(false)
  })

  test("a turn that recorded an error is NOT empty (1D's territory, not a stall)", () => {
    expect(isEmptyAssistantTurn([userMsg("go"), assistantMsg([], { message: "provider failed" })])).toBe(false)
  })

  test("no assistant message at all is not an empty turn", () => {
    expect(isEmptyAssistantTurn([userMsg("go")])).toBe(false)
  })
})
