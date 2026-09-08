import { describe, expect, test } from "bun:test"
import { announcedToolButCalledNone } from "@novaclaw/core/session/runner/doom-loop"
import type { SessionMessage } from "@novaclaw/schema/session-message"

/**
 * A turn that ANNOUNCES a tool call and never makes one.
 *
 * 🔴 Measured 2026-08-20 on holo3.1, asked to describe 400 icons. The entire run was:
 *
 *   "I need to describe each of the 400 PNG files… Let me start by listing all the files…
 *    First, let me get a complete listing of all files in the folder:"
 *
 * then `finish=stop`. Nine events, one step, no tool call, nothing done — and the harness recorded a
 * COMPLETED turn, so the session sat idle for twenty minutes with zero output.
 *
 * `isEmptyAssistantTurn` is blind to it: that needs no text AND no tool call, and this turn is all
 * text. Same underlying fault — the call never reached the harness — but with the narration still
 * attached, so every other check reads it as a normal answer.
 *
 * ⚠️ The risk in a text heuristic is nagging a user on ordinary finished turns, so the false-positive
 * cases below matter more than the true ones and are written first.
 */

const assistant = (text: string, tools: readonly string[] = []): SessionMessage.Message =>
  ({
    type: "assistant",
    content: [
      ...(text === "" ? [] : [{ type: "text", text }]),
      ...tools.map((name) => ({ type: "tool", name, state: { status: "completed" } })),
    ],
  }) as never

describe("it must NOT fire on an ordinary finished answer", () => {
  test("a completed summary ending on a statement", () => {
    expect(
      announcedToolButCalledNone([
        assistant(
          "I described all six glyphs: a broken heart, dice, a water droplet, a Kg weight, boots and a corset.",
        ),
      ]),
    ).toBe(false)
  })

  test("a turn that actually called a tool, however it is worded", () => {
    // ⭐ The load-bearing exclusion. A turn WITH a tool call is never this fault, even if its text
    // also narrates the next step — which is exactly how a healthy working turn reads.
    expect(announcedToolButCalledNone([assistant("Let me read the next icon:", ["read"])])).toBe(false)
  })

  test("an intent clause EARLIER in a long answer is normal narration", () => {
    // Only the last sentence counts. "I'll" in the middle of a finished answer is prose, not a stop.
    expect(
      announcedToolButCalledNone([
        assistant("I'll explain what I found. The folder holds 400 icons, and every one is 256x256 pixels."),
      ]),
    ).toBe(false)
  })

  test("a question to the user is not an abandoned tool call", () => {
    expect(announcedToolButCalledNone([assistant("Which of the two folders did you mean?")])).toBe(false)
  })

  test("an empty turn belongs to the OTHER detector", () => {
    // No text and no call is `isEmptyAssistantTurn`'s case; two detectors must not both fire.
    expect(announcedToolButCalledNone([assistant("")])).toBe(false)
  })

  test("a turn that errored is retry territory, not a stall", () => {
    const base = assistant("Let me look:") as unknown as Record<string, unknown>
    const errored = { ...base, error: { message: "boom" } }
    expect(announcedToolButCalledNone([errored as never])).toBe(false)
  })
})

describe("it MUST fire on the measured failure", () => {
  test("the verbatim turn from the 400-icon run", () => {
    expect(
      announcedToolButCalledNone([
        assistant(
          "I need to describe each of the 400 PNG files in this folder. Given the large number of " +
            "files, I'll need to work through them systematically. Let me start by listing all the " +
            "files to see the complete set, then I'll examine them in batches.\n\n" +
            "First, let me get a complete listing of all files in the folder:",
        ),
      ]),
    ).toBe(true)
  })

  test("a bare trailing colon — the strongest single signal", () => {
    // The model stopped exactly where the call goes. A finished answer does not end on a colon.
    expect(announcedToolButCalledNone([assistant("Now I will read the first icon:")])).toBe(true)
  })

  test("a promise in the final sentence without a colon", () => {
    expect(announcedToolButCalledNone([assistant("The folder has 400 files. Let me open the first one.")])).toBe(true)
    expect(announcedToolButCalledNone([assistant("I'll start by listing the directory.")])).toBe(true)
  })

  test("only the LAST assistant turn is judged", () => {
    // The detector runs at the end of a drain, so an older narrated turn that was already followed
    // by real work must not re-trigger it.
    expect(
      announcedToolButCalledNone([
        assistant("Let me look:"),
        assistant("Here is what the icon shows: a broken heart."),
      ]),
    ).toBe(false)
  })
})
