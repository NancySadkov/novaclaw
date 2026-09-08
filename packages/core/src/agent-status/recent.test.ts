import { expect, test } from "bun:test"
import { MAX_CHARS, RECENT_MESSAGES, recentText } from "./recent"
import type { SessionMessage } from "../session/message"

/**
 * 🔴 **These fixtures are the REAL transcript shapes, and the first version of this file invented
 * them.** It built `{ role, parts: [{ type: "text", text }] }`; the transcript has `type`, with
 * `text` on the user-ish members and a typed `content[]` on assistant turns. The code under test
 * made the same assumption, so every test passed — and the live sweep then found no text in a real
 * three-message conversation and reported `skipped: 1`. A fixture written from the same guess as the
 * code agrees with it by construction and measures nothing.
 */
const user = (text: string) => ({ type: "user", text }) as unknown as SessionMessage.Message
const assistant = (...parts: { type: string; text?: string }[]) =>
  ({ type: "assistant", content: parts }) as unknown as SessionMessage.Message
const switched = () => ({ type: "agent-switched", agent: "nova" }) as unknown as SessionMessage.Message

test("renders the conversation tail as role-tagged lines", () => {
  expect(recentText([user("look at the handshake"), assistant({ type: "text", text: "reading p2p.ts" })])).toBe(
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
  const many = Array.from({ length: RECENT_MESSAGES + 5 }, (_, i) => user(`message ${i}`))
  const text = recentText(many)!
  expect(text).toContain(`message ${RECENT_MESSAGES + 4}`)
  expect(text).not.toContain("message 0")
})

test("🔴 an assistant turn's REASONING and TOOL parts are left out", () => {
  // Reasoning is the model talking to itself; tool payloads are where a transcript's bulk lives, and
  // the label prompt forbids naming tools. Feeding either in asks the model to ignore most of its
  // input — and invites the code-shaped output the label cleaner exists to reject.
  expect(
    recentText([
      assistant(
        { type: "reasoning", text: "weighing options" },
        { type: "tool", text: "read /x" },
        { type: "text", text: "found the bug" },
      ),
    ]),
  ).toBe("assistant: found the bug")
  expect(recentText([assistant({ type: "tool", text: "bash" })])).toBeUndefined()
})

test("🔴 bookkeeping entries are not conversation", () => {
  // Agent/model/permission switches carry no `text` at all. They must be skipped, not rendered as a
  // line with nothing in it.
  expect(recentText([switched(), user("real words")])).toBe("user: real words")
  expect(recentText([switched()])).toBeUndefined()
})

test("a conversation with no text at all yields undefined, not an empty prompt", () => {
  // The pass must skip this colleague rather than ask the model to summarise nothing — which is how
  // an invented label gets written.
  expect(recentText([])).toBeUndefined()
  expect(recentText([user("   ")])).toBeUndefined()
})

test("🔴 an oversized transcript is truncated from the FRONT", () => {
  // The newest messages are what the label is about. Cutting the tail would answer the wrong
  // question with a perfectly full prompt.
  const text = recentText([user("x".repeat(MAX_CHARS * 2)), user("the newest thing")])!
  expect(text.length).toBeLessThanOrEqual(MAX_CHARS)
  expect(text.endsWith("the newest thing")).toBe(true)
})
