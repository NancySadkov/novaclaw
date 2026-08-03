import { describe, expect, test } from "bun:test"
import { selectTranscriptMessages } from "./transcript-view"

const agent = { id: "agent", type: "agent-switched" }
const model = { id: "model", type: "model-switched" }
const user = { id: "user", type: "user" }

describe("transcript setup markers", () => {
  test("an all-marker tail left by reverting the first prompt renders empty", () => {
    expect(selectTranscriptMessages([agent, model])).toEqual([])
  })

  test("drops only the initial setup run", () => {
    expect(selectTranscriptMessages([agent, model, user])).toEqual([user])
  })

  test("retains a model switch after the conversation begins", () => {
    expect(selectTranscriptMessages([user, model])).toEqual([user, model])
  })
})
