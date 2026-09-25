import { expect, test } from "bun:test"
import { attentionSessionIds, isNamedAgentSession, unseenOfficerSessions } from "./attention-ids"
import type { SessionLike } from "./roster-live"

test("attention deduplicates unseen chats", () => {
  expect(attentionSessionIds({ unseen: ["a", "b", "a"] })).toEqual(["a", "b"])
})
test("no unseen output needs no attention", () => {
  expect(attentionSessionIds({ unseen: [] })).toEqual([])
})

test("only named root sessions create response attention", () => {
  expect(isNamedAgentSession({ agent: "geryon" })).toBe(true)
  expect(isNamedAgentSession({ agent: "geryon", parentID: "ses_nova" })).toBe(false)
  expect(isNamedAgentSession({ agent: null, parentID: "ses_geryon" })).toBe(false)
  expect(isNamedAgentSession({ agent: null })).toBe(false)
  expect(isNamedAgentSession(undefined)).toBe(false)
})

test("an officer's badge counts unseen named chats, never anonymous worker completions", () => {
  const sessions: SessionLike[] = [
    { id: "older", agent: "geryon", time: { created: 1, updated: 2 } },
    { id: "latest", agent: "geryon", time: { created: 3, updated: 4 } },
    { id: "worker", agent: "geryon", parentID: "latest", type: "sub-agent", time: { created: 5 } },
    { id: "anonymous", parentID: "latest", type: "sub-agent", time: { created: 6 } },
    { id: "other", agent: "sopitis", time: { created: 7 } },
  ]
  expect(unseenOfficerSessions(sessions, "geryon", ["worker", "anonymous", "other", "older", "latest", "latest"]).map((row) => row.id)).toEqual(["latest", "older"])
})
