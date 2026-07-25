import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { SessionMarkdown } from "./session-markdown"

// The markdown export (Chats → Export as Markdown). The interesting requirement is the RUNNING case:
// a session exported mid-turn must be honest about it rather than reading as a finished transcript.

const OPTIONS = { sessionID: "ses_abc", title: "Hello, C", exportedAt: 1_700_000_000_000 }

// Cast through unknown: these fixtures are the wire shape, not full branded schema instances.
const msg = (value: Record<string, unknown>) => value as unknown as SessionMessage.Message

const user = (text: string) => msg({ type: "user", text, time: { created: 1_700_000_000_000 } })

const assistant = (content: Array<Record<string, unknown>>, finish: string | null = "stop") =>
  msg({
    type: "assistant",
    content,
    finish,
    model: { providerID: "dgx-spark", id: "qwen3.6-35b" },
    tokens: { input: 10, output: 5 },
    time: { created: 1_700_000_001_000 },
  })

describe("SessionMarkdown.render", () => {
  test("renders a finished session with prompts, replies and tool calls", () => {
    const result = SessionMarkdown.render(
      [
        user("write hello.c"),
        assistant([
          { type: "reasoning", text: "I should write the file." },
          { type: "tool", name: "write", state: { status: "completed", input: { path: "/w/hello.c" }, output: "ok" } },
          { type: "text", text: "Done — wrote hello.c." },
        ]),
      ],
      OPTIONS,
    )
    expect(result.running).toBe(false)
    expect(result.messageCount).toBe(2)
    expect(result.markdown).toContain("# Hello, C")
    expect(result.markdown).toContain("`ses_abc`")
    expect(result.markdown).toContain("## User")
    expect(result.markdown).toContain("write hello.c")
    expect(result.markdown).toContain("dgx-spark/qwen3.6-35b")
    expect(result.markdown).toContain("**Tool — write**")
    expect(result.markdown).toContain("Done — wrote hello.c.")
    expect(result.markdown).toContain("I should write the file.")
    // A finished export must NOT carry the still-running warning.
    expect(result.markdown).not.toContain("still running")
  })

  test("a turn with finish: null is reported as running and says so in the document", () => {
    const result = SessionMarkdown.render([user("go"), assistant([{ type: "text", text: "working" }], null)], OPTIONS)
    expect(result.running).toBe(true)
    expect(result.markdown).toContain("still running when it was exported")
    expect(result.markdown).toContain("ends mid-turn")
  })

  test("an in-flight tool is marked in place, not omitted", () => {
    const result = SessionMarkdown.render(
      [assistant([{ type: "tool", name: "bash", state: { status: "running", input: { command: "sleep 30" } } }], null)],
      OPTIONS,
    )
    expect(result.running).toBe(true)
    expect(result.markdown).toContain("**Tool — bash**")
    expect(result.markdown).toContain("still in flight at export")
    expect(result.markdown).toContain("sleep 30") // its input survives
  })

  test("a failed tool records the error", () => {
    const result = SessionMarkdown.render(
      [assistant([{ type: "tool", name: "bash", state: { status: "error", input: {}, error: { message: "boom" } } }])],
      OPTIONS,
    )
    expect(result.markdown).toContain("Failed: boom")
  })

  test("content containing a code fence does not break out of its block", () => {
    const nasty = "```\nnot the end\n```"
    const result = SessionMarkdown.render(
      [assistant([{ type: "tool", name: "bash", state: { status: "completed", input: {}, output: nasty } }])],
      OPTIONS,
    )
    // The wrapping fence must be LONGER than any run inside the payload.
    expect(result.markdown).toContain("````")
  })

  test("message types without a bespoke renderer are still labelled and kept", () => {
    const result = SessionMarkdown.render([msg({ type: "synthetic", text: "notice text", time: {} })], OPTIONS)
    expect(result.markdown).toContain("## Synthetic")
    expect(result.markdown).toContain("notice text")
  })

  // Regression: the schema field is `DateTimeUtcFromMillis`, so the value the SERVER passes in is an
  // Effect DateTime.Utc object, not the number seen on the wire. `new Date(thatObject).toISOString()`
  // throws, which surfaced as an opaque UnknownError on every session that had messages.
  test("accepts a decoded DateTime object as well as raw millis, and never throws on a bad one", () => {
    const withDateTime = msg({
      type: "user",
      text: "hi",
      time: { created: { epochMillis: 1_700_000_000_000 } },
    })
    const rendered = SessionMarkdown.render([withDateTime], OPTIONS)
    expect(rendered.markdown).toContain("2023-11-14")

    // Unformattable stamps are omitted rather than throwing.
    for (const bad of [{}, null, "nonsense", Number.NaN, Infinity]) {
      const result = SessionMarkdown.render([msg({ type: "user", text: "x", time: { created: bad } })], OPTIONS)
      expect(result.messageCount).toBe(1)
      expect(result.markdown).toContain("## User")
    }
  })

  test("an empty session still produces a valid header", () => {
    const result = SessionMarkdown.render([], OPTIONS)
    expect(result.messageCount).toBe(0)
    expect(result.running).toBe(false)
    expect(result.markdown).toContain("# Hello, C")
  })
})

describe("SessionMarkdown.filename", () => {
  test("slugs the title and always keeps the session id unique", () => {
    expect(SessionMarkdown.filename({ title: "Hello, C!", sessionID: "ses_abc" })).toBe("hello-c-ses_abc.md")
    expect(SessionMarkdown.filename({ sessionID: "ses_abc" })).toBe("ses_abc.md")
    expect(SessionMarkdown.filename({ title: "   ", sessionID: "ses_abc" })).toBe("ses_abc.md")
  })

  test("a wild title cannot escape the folder", () => {
    const name = SessionMarkdown.filename({ title: "../../etc/passwd", sessionID: "ses_abc" })
    expect(name).not.toContain("/")
    expect(name).not.toContain("..")
    expect(name.endsWith("-ses_abc.md")).toBe(true)
  })
})
