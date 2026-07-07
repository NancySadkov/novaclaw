import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { NamedError } from "../../src/util/error"

// Self-contained schema-backed NamedError fixtures (this used to live in
// @novaclaw/novaclaw and lean on the V1 session/message-error errors; those were
// deleted with the V1 engine, so the NamedError contract is exercised here in core
// where NamedError lives).
const WithFields = NamedError.create("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})
const WithoutFields = NamedError.create("MessageOutputLengthError", {})

describe("util.error", () => {
  test("schema-backed named errors are real NamedError instances", () => {
    const error = new WithFields({ providerID: "anthropic", message: "boom" })

    expect(error).toBeInstanceOf(NamedError)
    expect(error.toObject()).toEqual({ name: "ProviderAuthError", data: { providerID: "anthropic", message: "boom" } })
  })

  test("named errors without fields serialize data", () => {
    expect(new WithoutFields({}).toObject()).toEqual({ name: "MessageOutputLengthError", data: {} })
  })
})
