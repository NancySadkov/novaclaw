import { expect, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import { sessionCompactionEvents } from "./session-compaction-events"

test("builds a newest-first log with cause and before/after sizes", () => {
  const messages = [
    { type: "user", id: "u1", time: { created: 1 } },
    {
      type: "compaction",
      id: "c1",
      reason: "auto",
      metadata: {
        "compaction.cause": "overflow",
        "compaction.before.tokens": 240_123.8,
        "compaction.after.tokens": 16_430,
      },
      time: { created: 2 },
    },
    {
      type: "compaction-status",
      id: "c2",
      reason: "auto",
      status: "failed",
      failure: "summarizer-unavailable",
      metadata: { "compaction.cause": "threshold", "compaction.before.tokens": 88_745 },
      time: { created: 3 },
    },
  ] as unknown as SessionMessage[]

  expect(sessionCompactionEvents(messages)).toEqual([
    {
      id: "c2",
      at: 3,
      cause: "threshold",
      beforeTokens: 88_745,
      afterTokens: undefined,
      status: "failed",
      failure: "summarizer-unavailable",
    },
    {
      id: "c1",
      at: 2,
      cause: "overflow",
      beforeTokens: 240_123,
      afterTokens: 16_430,
      status: "completed",
      failure: undefined,
    },
  ])
})

test("old rows without metadata remain legible instead of inventing measurements", () => {
  const messages = [
    { type: "compaction", id: "c1", reason: "manual", time: { created: 1 } },
  ] as unknown as SessionMessage[]
  expect(sessionCompactionEvents(messages)).toEqual([
    {
      id: "c1",
      at: 1,
      cause: "manual",
      beforeTokens: undefined,
      afterTokens: undefined,
      status: "completed",
      failure: undefined,
    },
  ])
})
