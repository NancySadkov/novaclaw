import { describe, expect, test } from "bun:test"
import type { SessionMessageUser } from "@novaclaw/sdk/v2/client"
import { promptFromUserMessage } from "./prompt"

function user(fields: Partial<SessionMessageUser> & { text: string }): SessionMessageUser {
  return { id: "msg_1", type: "user", time: { created: 0 }, ...fields }
}

describe("promptFromUserMessage", () => {
  test("plain text → a single text part", () => {
    expect(promptFromUserMessage(user({ text: "hello" }))).toEqual([
      { type: "text", content: "hello", start: 0, end: 5 },
    ])
  })

  test("weaves an inline @-file mention at its source span", () => {
    const result = promptFromUserMessage(
      user({
        text: "see @src/a.ts now",
        files: [{ uri: "file:///repo/src/a.ts", mime: "text/plain", source: { start: 4, end: 13, text: "@src/a.ts" } }],
      }),
    )
    expect(result).toEqual([
      { type: "text", content: "see ", start: 0, end: 4 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 4, end: 13, selection: undefined },
      { type: "text", content: " now", start: 13, end: 17 },
    ])
  })

  test("weaves an inline @-agent mention", () => {
    const result = promptFromUserMessage(
      user({ text: "ask @build ok", agents: [{ name: "build", source: { start: 4, end: 10, text: "@build" } }] }),
    )
    expect(result).toEqual([
      { type: "text", content: "ask ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
      { type: "text", content: " ok", start: 10, end: 13 },
    ])
  })

  test("carries a file selection range from the uri query", () => {
    const result = promptFromUserMessage(
      user({
        text: "@a.ts",
        files: [{ uri: "file:///a.ts?start=3&end=9", mime: "text/plain", source: { start: 0, end: 5, text: "@a.ts" } }],
      }),
    )
    expect(result[0]).toMatchObject({
      type: "file",
      path: "a.ts",
      selection: { startLine: 3, endLine: 9, startChar: 0, endChar: 0 },
    })
  })

  test("makes attachment paths relative to the session directory", () => {
    const result = promptFromUserMessage(
      user({
        text: "@/repo/src/a.ts",
        files: [
          { uri: "file:///repo/src/a.ts", mime: "text/plain", source: { start: 0, end: 15, text: "@/repo/src/a.ts" } },
        ],
      }),
      { directory: "/repo" },
    )
    expect(result[0]).toMatchObject({ type: "file", path: "src/a.ts" })
  })

  test("appends data: file uris as image attachments", () => {
    const result = promptFromUserMessage(
      user({ text: "look", files: [{ uri: "data:image/png;base64,AAA", mime: "image/png", name: "a.png" }] }),
    )
    expect(result).toMatchObject([
      { type: "text", content: "look" },
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ])
  })

  test("empty text → a single empty text part", () => {
    expect(promptFromUserMessage(user({ text: "" }))).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })
})
