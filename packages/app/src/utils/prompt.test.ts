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
