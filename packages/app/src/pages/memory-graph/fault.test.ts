import { describe, expect, test } from "bun:test"
import { InstanceFetchError } from "@/utils/instance-fetch"
import { graphFault } from "./fault"

const httpError = (status: number, message: string) =>
  new InstanceFetchError({ method: "GET", route: "memory/graph", status, message, kind: undefined, text: "" })

describe("graphFault", () => {
  test("bad credentials are an ANSWER, so Retry is not offered", () => {
    for (const status of [401, 403]) {
      const fault = graphFault(httpError(status, "unauthorized"))
      expect(fault.retryable).toBe(false)
      expect(fault.reason).toContain("credentials")
    }
  })

  test("a missing route is not retryable either — the instance has no memory engine", () => {
    expect(graphFault(httpError(404, "not found")).retryable).toBe(false)
  })

  test("a 500 keeps the engine's own words and offers Retry", () => {
    const fault = graphFault(httpError(500, "wasm engine panicked"))
    expect(fault.retryable).toBe(true)
    expect(fault.reason).toContain("wasm engine panicked")
  })

  test("no server at all is a DIFFERENT fact from the server saying no", () => {
    const fault = graphFault(new TypeError("Failed to fetch"))
    expect(fault.reason).toBe("Could not reach this instance.")
    expect(fault.retryable).toBe(true)
  })

  test("a timeout says so rather than blaming the network", () => {
    const abort = new Error("aborted")
    abort.name = "TimeoutError"
    expect(graphFault(abort).reason).toContain("too long")
  })

  test("a non-Error rejection still produces one calm sentence", () => {
    const fault = graphFault("boom")
    expect(fault.reason).toBe("The memory graph could not be read.")
    expect(fault.retryable).toBe(true)
  })

  test("a long server message is capped — the panel is not a log viewer", () => {
    const fault = graphFault(httpError(400, "x".repeat(400)))
    expect(fault.reason.length).toBeLessThanOrEqual(140)
  })

  test("NO fault ever reads as an empty cabinet", () => {
    // The regression this module exists for: every one of these used to render
    // "Nothing remembered yet — the graph fills as you chat."
    const errors: unknown[] = [httpError(401, "no"), httpError(500, "no"), new TypeError("Failed to fetch"), "boom"]
    for (const error of errors) expect(graphFault(error).reason).not.toContain("Nothing remembered")
  })
})
