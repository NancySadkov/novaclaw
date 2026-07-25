// The silent-no-op guard. The three "observed live" cases are the real turns from
// notes/osint/silent-noop-bug.md — each one previously settled as SUCCESS having done nothing.
import { describe, expect, test } from "bun:test"
import { TextualCall } from "@novaclaw/core/session/runner/textual-call"

const TOOLS = ["bash", "webfetch", "websearch", "write", "read", "edit"]

describe("detect — the turns that actually shipped a silent no-op", () => {
  test("observed live (run C): a fenced ```bash block with a real command", () => {
    const text = [
      "I'll begin by searching in Russian for LNR/DNR influencers.",
      "",
      "**Step 1: Initial searches**",
      "",
      '```bash',
      `bash -c "echo 'Starting LNR/DNR influencer research'"`,
      "```",
    ].join("\n")
    const found = TextualCall.detect(text, TOOLS)
    expect(found?.tell).toBe("fenced-tool")
    expect(found?.detail).toContain("bash")
  })

  test("observed live (run A): a ```json block DEFINING an invented tool still counts as an attempt", () => {
    const text = [
      "**Step 1: Initial searches — identity family**",
      "",
      "```json",
      '{"command": "", "name": "web-search-ru-influencers", "description": "Search for LNR/DNR figures"}',
      "```",
    ].join("\n")
    const found = TextualCall.detect(text, TOOLS)
    // The name resolves to nothing — that is precisely the mistake to correct, not a reason to ignore it.
    expect(found?.tell).toBe("fenced-json-call")
    expect(found?.detail).toContain("web-search-ru-influencers")
  })

  test("observed live (run B): a literal <thinking> tag in the content channel", () => {
    const text = "I'll research systematically.\n\n<thinking>\nThe user wants LNR/DNR figures.\n</thinking>"
    expect(TextualCall.detect(text, TOOLS)?.tell).toBe("tool-tag")
  })

  test("observed live (run B): the verbatim-repeated block — a content-channel loop", () => {
    const para =
      "The user wants me to research public influencers associated with the LNR/DNR information space. " +
      "This is a media monitoring task, so I need to search for war correspondents, channel operators, " +
      "and officials who function as media figures, then profile each one carefully."
    const text = `Intro line.\n\n${para}\n\nSome bridging text here.\n\n${para}\n`
    const found = TextualCall.detect(text, TOOLS)
    expect(found?.tell).toBe("repeated-block")
  })
})

describe("detect — negatives (a false positive costs a wasted steer, so pin them)", () => {
  test("a genuine finished answer is left alone", () => {
    const text =
      "I searched three sources and confirmed the figure. The brief is written to report.md. " +
      "Two sources were inaccessible (403) and are recorded as such."
    expect(TextualCall.detect(text, TOOLS)).toBeUndefined()
  })

  test("a fence in a language that is NOT one of our tools is ordinary output", () => {
    const text = "Here is the C program:\n\n```c\nint main(void){return 0;}\n```"
    expect(TextualCall.detect(text, TOOLS)).toBeUndefined()
  })

  test("empty / whitespace text is not a tell", () => {
    expect(TextualCall.detect("", TOOLS)).toBeUndefined()
    expect(TextualCall.detect("   \n  ", TOOLS)).toBeUndefined()
  })

  test("an empty fenced tool block is not an attempted call", () => {
    expect(TextualCall.detect("```bash\n\n```", TOOLS)).toBeUndefined()
  })

  test("a short repeated line (a heading, a stock phrase) is not a loop", () => {
    const text = "## Findings\n\nshort repeated line\n\nmiddle\n\nshort repeated line\n"
    expect(TextualCall.detect(text, TOOLS)).toBeUndefined()
  })

  test("plain JSON output that is not a call object is left alone", () => {
    const text = 'Result:\n\n```json\n{"count": 3, "ok": true}\n```'
    expect(TextualCall.detect(text, TOOLS)).toBeUndefined()
  })

  test("no allowed tools => a bare fence cannot be a tool call", () => {
    expect(TextualCall.detect("```bash\nls -la\n```", [])).toBeUndefined()
  })
})

describe("recoveryMessage", () => {
  test("names the mistake, demands a real call, and leaves an honest way out", () => {
    const message = TextualCall.recoveryMessage({ tell: "fenced-tool", detail: "fenced `bash` block" })
    expect(message).toContain("fenced `bash` block")
    expect(message).toContain("does NOT run it")
    expect(message).toContain("do not invent a tool")
    // The escape hatch matters: a legitimate illustration must be able to end the turn honestly.
    expect(message).toContain("only an illustration")
  })
})
