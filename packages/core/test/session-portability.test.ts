import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionPortability } from "@novaclaw/core/session/portability"

/**
 * The reader is the risky half of session import: it meets another harness's JSON, which we do not
 * control. Two invariants matter and both are asserted here:
 *
 *  1. a recognisable transcript becomes NovaClaw-shaped messages; and
 *  2. an ENCRYPTED reasoning trace keeps its opaque payload verbatim — Anthropic re-verifies the
 *     signature on every later turn, so dropping it turns a legal import into one the provider refuses.
 */

/** A representative slice of a foreign V2 export, including a signed (encrypted) thinking block. */
const foreignDocument = {
  info: { id: "ses_source", agent: "build", title: "Reverse engineering functions", model: { id: "m", providerID: "p" } },
  messages: [
    { id: "msg_u", type: "user", time: { created: 1 }, text: "do the thing", files: [], agents: [] },
    {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model: { id: "muse", providerID: "vendor", variant: "default" },
      time: { created: 2, completed: 5 },
      content: [
        {
          type: "reasoning",
          text: "visible thinking",
          providerMetadata: { anthropic: { signature: "SIGNED-BLOB-abc123", redactedData: "REDACTED-xyz" } },
          time: { created: 3, completed: 4 },
        },
        { type: "text", text: "Here is the answer." },
        {
          type: "tool",
          id: "call_1",
          name: "shell",
          executed: false,
          state: {
            status: "completed",
            input: { command: "ls" },
            content: [{ type: "text", text: "file.txt" }],
            metadata: { exit: 0 },
          },
          time: { created: 3, ran: 4, completed: 5 },
        },
        { type: "step-start" },
      ],
    },
    { id: "msg_idle", type: "idle", outcome: "succeeded" },
  ],
}

describe("SessionPortability", () => {
  test("reads a foreign export into NovaClaw-shaped messages", () => {
    const parsed = SessionPortability.parse(foreignDocument)
    expect(parsed.title).toBe("Reverse engineering functions")
    expect(parsed.agent).toBe("build")
    expect(parsed.messages.map((message) => message.type)).toEqual(["user", "assistant"])
    // `idle` is not a transcript message; it is counted as skipped rather than imitated.
    expect(parsed.skipped).toBe(1)

    const assistant = parsed.messages[1] as {
      agent: string
      model: { providerID: string; id: string }
      content: Array<Record<string, unknown>>
    }
    expect(assistant.agent).toBe("build")
    expect(assistant.model).toEqual({ providerID: "vendor", id: "muse" })
    expect(assistant.content.map((part) => part.type)).toEqual(["reasoning", "text", "tool"])
    // `step-start` is an unknown part kind: dropped, never guessed at.
  })

  test("🔴 an encrypted reasoning trace keeps its providerMetadata verbatim", () => {
    const assistant = SessionPortability.parse(foreignDocument).messages[1] as {
      content: Array<{ type: string; text?: string; providerMetadata?: Record<string, Record<string, unknown>> }>
    }
    const reasoning = assistant.content.find((part) => part.type === "reasoning")!
    expect(reasoning.text).toBe("visible thinking")
    // Byte-for-byte, because the provider re-verifies it on the next turn.
    expect(reasoning.providerMetadata?.anthropic?.signature).toBe("SIGNED-BLOB-abc123")
    expect(reasoning.providerMetadata?.anthropic?.redactedData).toBe("REDACTED-xyz")
  })

  test("a redacted block with no visible text imports as an empty-text reasoning part", () => {
    const document = {
      messages: [
        {
          type: "assistant",
          content: [{ type: "reasoning", providerMetadata: { anthropic: { redactedData: "OPAQUE" } } }],
        },
      ],
    }
    const assistant = SessionPortability.parse(document).messages[0] as {
      content: Array<{ type: string; text: string; providerMetadata?: Record<string, Record<string, unknown>> }>
    }
    expect(assistant.content[0]).toMatchObject({ type: "reasoning", text: "" })
    expect(assistant.content[0]?.providerMetadata?.anthropic?.redactedData).toBe("OPAQUE")
  })

  test("unknown fields on an unrecognised part are preserved, not discarded", () => {
    const document = {
      messages: [{ type: "assistant", content: [{ type: "reasoning", text: "t", thoughtSignature: "TS-1" }] }],
    }
    const assistant = SessionPortability.parse(document).messages[0] as {
      content: Array<{ providerMetadata?: Record<string, Record<string, unknown>> }>
    }
    expect(assistant.content[0]?.providerMetadata?.imported?.thoughtSignature).toBe("TS-1")
  })

  test("a completed tool keeps its input, text content and structured metadata", () => {
    const assistant = SessionPortability.parse(foreignDocument).messages[1] as {
      content: Array<{ type: string; name?: string; state?: Record<string, unknown>; time?: Record<string, number> }>
    }
    const tool = assistant.content.find((part) => part.type === "tool")!
    expect(tool.name).toBe("shell")
    expect(tool.state).toMatchObject({
      status: "completed",
      input: { command: "ls" },
      content: [{ type: "text", text: "file.txt" }],
      structured: { exit: 0 },
    })
    expect(tool.time?.completed).toBe(5)
  })

  test("every imported message decodes as the message the recorder accepts", () => {
    // The reader's output is published as `SessionEvent.MessageRecorded`, whose payload is this
    // schema. Decoding here is what stops a mapping mistake from becoming a failed import at the
    // endpoint — the server validates, but a unit test names WHICH shape was wrong.
    const decode = Schema.decodeUnknownSync(SessionMessage.Message)
    for (const message of SessionPortability.parse(foreignDocument).messages) {
      const decoded = decode({ ...message, id: SessionMessage.ID.create() }) as { type: string }
      expect(decoded.type).toBe(message.type as string)
    }
  })

  test("our own export round-trips through the reader", () => {
    const parsed = SessionPortability.parse(foreignDocument)
    const exported = SessionPortability.exportDocument({ info: { title: parsed.title }, messages: parsed.messages })
    const again = SessionPortability.parse(exported)
    expect(again.messages).toEqual(parsed.messages)
  })

  test("a file that is not a session is refused with a sentence, not a crash", () => {
    expect(() => SessionPortability.parse("not json")).toThrow("not valid JSON")
    expect(() => SessionPortability.parse({ hello: "world" })).toThrow("session export")
    expect(() => SessionPortability.parse({ messages: [] })).toThrow("no messages")
    expect(() => SessionPortability.parse({ messages: [{ type: "idle" }] })).toThrow("None of the messages")
  })
})
