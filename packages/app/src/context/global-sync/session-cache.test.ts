import { describe, expect, test } from "bun:test"
import type {
  PermissionV2Request,
  QuestionRequest,
  SessionStatus,
  SessionChangeDiff,
  Todo,
} from "@novaclaw/sdk/v2/client"
import { dropSessionCaches, pickSessionCacheEvictions } from "./session-cache"

describe("app session cache", () => {
  test("dropSessionCaches clears every per-session cache for stale sessions only", () => {
    const store: {
      session_status: Record<string, SessionStatus | undefined>
      session_diff: Record<string, SessionChangeDiff[] | undefined>
      todo: Record<string, Todo[] | undefined>
      permission: Record<string, PermissionV2Request[] | undefined>
      question: Record<string, QuestionRequest[] | undefined>
    } = {
      session_status: { ses_1: { type: "busy" } as SessionStatus },
      session_diff: { ses_1: [] },
      todo: { ses_1: [] as Todo[], ses_keep: [] as Todo[] },
      permission: { ses_1: [] as PermissionV2Request[] },
      question: { ses_1: [] as QuestionRequest[] },
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.todo.ses_1).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
    // untouched sessions survive
    expect(store.todo.ses_keep).toEqual([])
  })

  test("pickSessionCacheEvictions preserves requested sessions", () => {
    const seen = new Set(["ses_1", "ses_2", "ses_3"])

    const stale = pickSessionCacheEvictions({
      seen,
      keep: "ses_4",
      limit: 2,
      preserve: ["ses_1"],
    })

    expect(stale).toEqual(["ses_2", "ses_3"])
    expect([...seen]).toEqual(["ses_1", "ses_4"])
  })
})
