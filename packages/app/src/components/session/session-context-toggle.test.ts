import { describe, expect, test } from "bun:test"
import { sessionContextAction } from "./session-context-toggle"

describe("sessionContextAction", () => {
  test("the first click reopens a closed panel whose hidden Context tab is still active", () => {
    expect(sessionContextAction({ panelOpened: false, activeTab: "context" })).toBe("open-panel")
  })

  test("an already visible Context tab toggles closed", () => {
    expect(sessionContextAction({ panelOpened: true, activeTab: "context" })).toBe("close-tab")
  })

  test("a different visible tab switches to Context", () => {
    expect(sessionContextAction({ panelOpened: true, activeTab: "file:///readme.md" })).toBe("open-panel")
  })
})
