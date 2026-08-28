import { expect, test } from "bun:test"
import { MAX_CHARS, RECENT_MESSAGES, recentText } from "./recent"
import type { SessionMessage } from "../session/message"

const say = (role: string, text: string) =>
  ({ role, parts: [{ type: "text", text }] }) as unknown as SessionMessage.Message

const tool = (name: string) =>
  ({
    role: "assistant",
    parts: [{ type: "tool", tool: name, state: { input: { path: "/x" } } }],
  }) as unknown as SessionMessage.Message

test("renders the conversation tail as role-tagged lines", () => {
  expect(recentText([say("user", "look at the handshake"), say("assistant", "reading p2p.ts")])).toBe(
    "user: look at the handshake\nassistant: reading p2p.ts",
  )
})

test("🔴 reads the TAIL, not the head", () => {
  /**
   * The retired session title read the FIRST user message, because a name for a conversation should
   * not move. A status must move — it answers what is happening NOW. Sharing the titler's input
   * would produce a line permanently about whatever the colleague was asked first.
   *
   * A/B: change `slice(-RECENT_MESSAGES)` to `slice(0, RECENT_MESSAGES)` and this fails.
   */
  const many = Array.from({ length: RECENT_MESSAGES + 5 }, (_, i) => say("user", `message ${i}`))
  const text = recentText(many)!
  expect(text).toContain(`message ${RECENT_MESSAGES + 4}`)
  expect(text).not.toContain("message 0")
})

test("🔴 tool parts are left out entirely", () => {
  // The prompt forbids naming tools, and tool payloads are where a transcript's bulk lives. Feeding
  // them in asks the model to ignore most of what it was given — and invites the code-shaped output
  // the label cleaner exists to reject.
  expect(recentText([tool("read"), say("assistant", "found the bug")])).toBe("assistant: found the bug")
  expect(recentText([tool("read"), tool("bash")])).toBeUndefined()
})

test("a conversation with no text at all yields undefined, not an empty prompt", () => {
  // The pass must skip this colleague rather than ask the model to summarise nothing — which is how
  // an invented label gets written.
  expect(recentText([])).toBeUndefined()
  expect(recentText([say("user", "   ")])).toBeUndefined()
})

test("🔴 an oversized transcript is truncated from the FRONT", () => {
  // The newest messages are what the label is about. Cutting the tail would answer the wrong
  // question with a perfectly full prompt.
  const text = recentText([say("user", "x".repeat(MAX_CHARS * 2)), say("assistant", "the newest thing")])!
  expect(text.length).toBeLessThanOrEqual(MAX_CHARS)
  expect(text.endsWith("the newest thing")).toBe(true)
})
