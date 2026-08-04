import { describe, expect, test } from "bun:test"
import { RequestDeadlineError, withRequestDeadline } from "./request-deadline"

describe("withRequestDeadline", () => {
  test("settles even when a transport ignores abort", async () => {
    const pending = withRequestDeadline({
      label: "Loading sessions",
      timeoutMs: 5,
      run: () => new Promise<never>(() => undefined),
    })

    await expect(pending).rejects.toBeInstanceOf(RequestDeadlineError)
    await expect(pending).rejects.toThrow("Loading sessions timed out")
  })

  test("aborts a cooperative transport with the same actionable error", async () => {
    let reason: unknown
    const pending = withRequestDeadline({
      label: "Loading this session",
      timeoutMs: 5,
      run: (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason
            reject(signal.reason)
          })
        }),
    })

    await expect(pending).rejects.toThrow("Check the instance connection and try again")
    expect(reason).toBeInstanceOf(RequestDeadlineError)
  })

  test("clears the deadline after a successful request", async () => {
    expect(
      await withRequestDeadline({
        label: "Loading sessions",
        timeoutMs: 5,
        run: async () => "ready",
      }),
    ).toBe("ready")
    await Bun.sleep(10)
  })
})
