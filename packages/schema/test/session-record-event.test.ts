import { describe, expect, test } from "bun:test"
import { PermissionRuleset } from "../src/permission-ruleset"
import { QuestionRequest } from "../src/question-request"
import { SessionRecordEvent } from "../src/session-record-event"

// V1-nuke slice D: the record lifecycle vocabulary pin. The V1 wire schemas died; these events
// keep their type strings but carry the NATIVE Session.Info at durable v2. session.diff and
// command.executed were deleted outright (no publishers existed).

describe("session record event schemas", () => {
  test("owns the record lifecycle definitions", () => {
    expect(SessionRecordEvent.Definitions.map((event) => event.type)).toEqual([
      "session.created",
      "session.updated",
      "session.deleted",
      "session.error",
    ])
    const durable = SessionRecordEvent.Definitions.filter((event) => event.durable !== undefined)
    expect(durable).toHaveLength(3)
    expect(durable.every((event) => event.durable?.aggregate === "sessionID")).toBe(true)
    expect(durable.every((event) => event.durable?.version === 2)).toBe(true)
  })

  test("owns the re-homed live vocabulary", () => {
    expect([
      SessionRecordEvent.Error.type,
      PermissionRuleset.Event.Asked.type,
      PermissionRuleset.Event.Replied.type,
      QuestionRequest.Event.Asked.type,
      QuestionRequest.Event.Replied.type,
      QuestionRequest.Event.Rejected.type,
    ]).toEqual([
      "session.error",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
    ])
  })
})
