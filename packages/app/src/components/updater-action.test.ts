import { describe, expect, test } from "bun:test"
import { updaterAction, updaterRefusal } from "./updater-action"

describe("updaterAction", () => {
  test("disables update actions when the platform has no updater", () => {
    expect(updaterAction(undefined)).toEqual({ label: "settings.updates.action.checkNow" })
  })

  test("projects updater transitions into one settings action", () => {
    expect(updaterAction({ status: "idle" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "checking" })).toEqual({ label: "settings.updates.action.checking" })
    expect(updaterAction({ status: "downloading", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.downloading",
    })
    expect(updaterAction({ status: "ready", version: "2.0.0" })).toEqual({
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.installing",
    })
    expect(updaterAction({ status: "blocked", reason: "airgap" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
  })

  test("projects updater refusals into truthful copy", () => {
    expect(updaterRefusal({ status: "blocked", reason: "airgap" })).toBe("settings.updates.refusal.airgap")
    expect(updaterRefusal({ status: "blocked", reason: "policy-unavailable" })).toBe(
      "settings.updates.refusal.policyUnavailable",
    )
    expect(updaterRefusal({ status: "idle" })).toBeUndefined()
  })
})
