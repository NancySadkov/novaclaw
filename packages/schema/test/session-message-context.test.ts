import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionID } from "../src/session-id"
import { SessionMessage } from "../src/session-message"

const decode = Schema.decodeUnknownSync(SessionMessage.Context)

const base = {
  window: 32_000,
  estimatedTokens: 12_000,
  droppedMessages: 0,
  elidedOutputs: 0,
  findings: [],
}

const promptAnchor = {
  sessionID: SessionID.make("ses_context_anchor"),
  contextEpoch: 7,
  providerID: "provider",
  modelID: "model",
  serverKey: "http://server/v1",
  routeID: "route",
  protocolID: "protocol",
  controllerKey: "plain",
  shapeKey: "abc123",
  heuristicTokens: 100,
  reportedTokens: 120,
}

describe("SessionMessage.Context prompt anchor", () => {
  test("old context without a prompt anchor still decodes", () => {
    expect(decode(base)).toEqual(base)
  })

  test("the content-free durable pair round-trips", () => {
    expect(decode({ ...base, promptAnchor })).toEqual({ ...base, promptAnchor })
  })

  test("the actual server identity is required", () => {
    const { serverKey: _, ...withoutServer } = promptAnchor
    expect(() => decode({ ...base, promptAnchor: { ...withoutServer, deviceKey: "physical-device" } })).toThrow()
  })

  test("zero, negative, and non-finite anchor token counts are rejected", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decode({ ...base, promptAnchor: { ...promptAnchor, reportedTokens: value } })).toThrow()
      expect(() => decode({ ...base, promptAnchor: { ...promptAnchor, heuristicTokens: value } })).toThrow()
    }
  })
})
