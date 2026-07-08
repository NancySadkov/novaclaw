import { describe, expect, test } from "bun:test"
import { SessionV1 as Wire } from "@novaclaw/schema/session-v1"
import { SessionV1 } from "../src/v1/session"

describe("legacy event schema compatibility", () => {
  test("Core references canonical SessionV1 definitions", () => {
    expect(SessionV1.Event.Created).toBe(Wire.Event.Created)
    // F1g: the message/part events retired with the legacy tables; a surviving session-level
    // event still proves core re-exports the canonical schema definitions by identity.
    expect(SessionV1.Event.Updated).toBe(Wire.Event.Updated)
  })

  test("Core retains NamedError constructor identity", () => {
    const error = new SessionV1.APIError({ message: "failed", isRetryable: false })
    expect(error).toBeInstanceOf(SessionV1.APIError)
    expect(error.toObject()).toEqual({ name: "APIError", data: { message: "failed", isRetryable: false } })
  })
})
