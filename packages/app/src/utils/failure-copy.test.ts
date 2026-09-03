import { describe, expect, test } from "bun:test"
import { classifyFailure, describeFailure } from "./failure-copy"

/**
 * Owner, 2026-09-03, on seeing `Failed to fetch (+2 more)` in a toast: *"extremely obtuse … it tells
 * the user nothing. What did NovaClaw try to fetch? From where? Why could it have failed? What is the
 * user supposed to do now?"*
 *
 * Four questions. These tests are those four questions.
 */
describe("a failure says what was attempted, where, and what to do", () => {
  const fetchFailure = new TypeError("Failed to fetch")

  test("🔴 names the OPERATION, in the user's words", () => {
    const copy = describeFailure(fetchFailure, { operation: "start a chat with Daedalus" })
    expect(copy.headline).toContain("start a chat with Daedalus")
  })

  test("🔴 names WHERE it was attempted", () => {
    const copy = describeFailure(fetchFailure, { operation: "start a chat", target: "spark" })
    expect(copy.headline).toContain("spark")
    expect(copy.remedy).toContain("spark")
  })

  test("🔴 says what the user can DO", () => {
    const copy = describeFailure(fetchFailure, { operation: "start a chat" })
    expect(copy.remedy).toBeDefined()
    expect(copy.remedy).toMatch(/running/i)
  })

  test("🔴 the transport's own words are KEPT — moved behind the sentence, never deleted", () => {
    // The detail is what a developer needs and the headline is what the user needs. Losing the
    // former to fix the latter would be trading one unusable error for another.
    const copy = describeFailure(fetchFailure, { operation: "start a chat" })
    expect(copy.detail).toContain("Failed to fetch")
    expect(copy.headline).not.toContain("Failed to fetch")
  })

  test("CONTROL — a refusal is not an outage, and says so", () => {
    // The distinction that matters: waiting fixes an outage and never fixes a rejection. Sending
    // someone to restart a service that answered them correctly is the wrong instruction.
    const copy = describeFailure(new Error("HTTP 401 Unauthorized"), { operation: "start a chat" })
    expect(classifyFailure(new Error("HTTP 401 Unauthorized"))).toBe("rejected")
    expect(copy.remedy).toMatch(/credential|password/i)
    expect(copy.remedy).not.toMatch(/running/i)
  })

  test("CONTROL — an unrecognised fault makes no promise it cannot keep", () => {
    // No remedy is better than a wrong one. A guessed instruction that does not help is how a user
    // learns to stop reading the errors.
    const copy = describeFailure(new Error("kaboom"), { operation: "start a chat" })
    expect(copy.remedy).toBeUndefined()
    expect(copy.detail).toContain("kaboom")
  })

  test("CONTROL — a bare string still yields a usable sentence", () => {
    // Not every throw site throws an Error. The copy must not depend on that.
    const copy = describeFailure("something went wrong", { operation: "start a chat" })
    expect(copy.headline).toContain("start a chat")
    expect(copy.detail).toContain("something went wrong")
  })
})
