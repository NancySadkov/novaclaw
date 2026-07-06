import { describe, expect, test } from "bun:test"
import type { PermissionV2Request, QuestionRequest } from "@novaclaw/sdk/v2/client"
import { attentionSessionIds } from "./attention-ids"

const ask = (sessionID: string) => ({ id: `per_${sessionID}`, sessionID }) as PermissionV2Request
const question = (sessionID: string) => ({ id: `q_${sessionID}`, sessionID }) as QuestionRequest

describe("attentionSessionIds", () => {
  test("unions permission, question, and unseen sources deduped", () => {
    const ids = attentionSessionIds({
      permission: { a: [ask("a")], b: [ask("b")] },
      question: { b: [question("b")], c: [question("c")] },
      unseen: ["c", "d"],
      countsAsk: () => true,
    })
    expect(ids.sort()).toEqual(["a", "b", "c", "d"])
  })

  test("auto-responded asks and empty lists do not count", () => {
    const ids = attentionSessionIds({
      permission: { a: [ask("a")], b: [] },
      question: { c: [] },
      unseen: [],
      countsAsk: () => false,
    })
    expect(ids).toEqual([])
  })
})
