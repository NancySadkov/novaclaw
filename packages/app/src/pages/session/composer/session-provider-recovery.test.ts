import { describe, expect, test } from "bun:test"
import { visibleProviderRecovery } from "./session-provider-recovery"

const recovery = { attemptID: "attempt", toolProtocol: false }

describe("visibleProviderRecovery", () => {
  test("hides the crash marker while its provider attempt is still active", () => {
    expect(visibleProviderRecovery({ recovery, working: true, dismissedAttemptID: undefined })).toBeUndefined()
  })

  test("shows a marker left behind after the session stopped working", () => {
    expect(visibleProviderRecovery({ recovery, working: false, dismissedAttemptID: undefined })).toBe(recovery)
  })

  test("keeps a dismissed stale attempt hidden", () => {
    expect(visibleProviderRecovery({ recovery, working: false, dismissedAttemptID: "attempt" })).toBeUndefined()
  })
})
