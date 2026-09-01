import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@novaclaw/sdk/v2/client"
import { attentionSessionIds } from "./attention-ids"

const question = (sessionID: string) => ({ id: `q_${sessionID}`, sessionID }) as QuestionRequest

describe("attentionSessionIds", () => {
  test("unions question and unseen sources deduped", () => {
    const ids = attentionSessionIds({
      question: { a: [question("a")], c: [question("c")] },
      unseen: ["c", "d"],
    })
    expect(ids.sort()).toEqual(["a", "c", "d"])
  })

  test("empty question lists do not count", () => {
    const ids = attentionSessionIds({
      question: { c: [] },
      unseen: [],
    })
    expect(ids).toEqual([])
  })
})
