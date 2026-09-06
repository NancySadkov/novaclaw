import { expect, test } from "bun:test"
import { attentionSessionIds } from "./attention-ids"

test("attention deduplicates unseen chats", () => {
  expect(attentionSessionIds({ unseen: ["a", "b", "a"] })).toEqual(["a", "b"])
})
test("no unseen output needs no attention", () => {
  expect(attentionSessionIds({ unseen: [] })).toEqual([])
})
