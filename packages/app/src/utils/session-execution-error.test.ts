import { describe, expect, test } from "bun:test"
import { InstanceFetchError } from "./instance-fetch"
import { shouldSuppressSessionExecutionError } from "./session-execution-error"

describe("session execution error policy", () => {
  test("transport failures belong to the connection banner", () => {
    expect(shouldSuppressSessionExecutionError(new TypeError("Failed to fetch"), "ses_x")).toBe(true)
  })

  test("a deleted session belongs to tab reconciliation", () => {
    expect(shouldSuppressSessionExecutionError(new Error("Session not found: ses_x"), "ses_x")).toBe(true)
  })

  test("server answers remain visible to the user", () => {
    const error = new InstanceFetchError({
      method: "POST",
      route: "/api/session/ses_x/execution/retry",
      status: 500,
      kind: undefined,
      message: "The instance could not retry the session",
      text: "failure",
    })
    expect(shouldSuppressSessionExecutionError(error, "ses_x")).toBe(false)
  })
})
