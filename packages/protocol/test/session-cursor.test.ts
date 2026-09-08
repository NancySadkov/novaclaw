import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionHistoryQuery, SessionHistoryResponse, SessionsCursor } from "../src/groups/session"
import { Session } from "@novaclaw/schema/session"

describe("SessionsCursor", () => {
  test("round trips without Node globals", async () => {
    const input = {
      workspace: undefined,
      search: "protocol",
      order: "desc" as const,
      anchor: { id: Session.ID.make("ses_test"), time: 1, direction: "next" as const },
    }
    const cursor = SessionsCursor.make(input)

    expect(await Effect.runPromise(SessionsCursor.parse(cursor))).toEqual(input)
  })
})

describe("SessionHistoryQuery", () => {
  test("decodes numeric paging inputs", async () => {
    const query = await Effect.runPromise(Schema.decodeUnknownEffect(SessionHistoryQuery)({ after: "3", limit: "10" }))

    expect(query).toEqual({ after: 3, limit: 10 })
  })
})

describe("SessionHistoryResponse", () => {
  test("keeps the existing JSON shape behind a named declaration boundary", () => {
    const response = Schema.decodeUnknownSync(SessionHistoryResponse)({ data: [], hasMore: true })

    expect(response).toBeInstanceOf(SessionHistoryResponse)
    expect(Schema.encodeSync(SessionHistoryResponse)(response)).toEqual({ data: [], hasMore: true })
  })
})
