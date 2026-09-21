import { describe, expect, test } from "bun:test"
import type { SessionTab, Tab } from "@/context/tabs"
import { officerSettingsDestination, officerSettingsTab, settingsOfficerID } from "./titlebar-officer-settings"

const tab = { type: "session", server: "local", sessionId: "ses_architect", agent: "Chief Architect" } as SessionTab

describe("officer tabs preserve the settings view", () => {
  test("matches and decodes only the officer settings route", () => {
    expect(settingsOfficerID("/officers/Chief%20Architect/settings")).toBe("Chief Architect")
    expect(settingsOfficerID("/officers/nova/settings/")).toBe("nova")
    expect(settingsOfficerID("/officers/%ZZ/settings")).toBeUndefined()
    expect(settingsOfficerID("/tasks")).toBeUndefined()
    expect(settingsOfficerID("/officers/nova/settings/other")).toBeUndefined()
  })

  test("selects the officer settings and retains the original return destination", () => {
    const returnTo = "/session/local/ses_nova?view=chat"
    expect(officerSettingsDestination("/officers/nova/settings", `?${new URLSearchParams({ returnTo })}`, tab)).toBe(
      `/officers/Chief%20Architect/settings?${new URLSearchParams({ returnTo })}`,
    )
    expect(officerSettingsDestination("/officers/nova/settings", "?returnTo=https://example.com", tab)).toBe(
      "/officers/Chief%20Architect/settings",
    )
    expect(officerSettingsDestination("/officers/nova/settings", "?returnTo=//example.com", tab)).toBe(
      "/officers/Chief%20Architect/settings",
    )
  })

  test("ordinary chats, worker tabs and unassigned tabs retain their normal destinations", () => {
    const draft = { type: "draft", server: "local", draftID: "new", directory: "/tmp" } as Tab
    expect(officerSettingsDestination("/tasks", "", tab)).toBeUndefined()
    expect(officerSettingsDestination("/officers/nova/settings", "", draft)).toBeUndefined()
    expect(officerSettingsDestination("/officers/nova/settings", "", { ...tab, worker: true })).toBeUndefined()
    expect(officerSettingsDestination("/officers/nova/settings", "", { ...tab, agent: undefined })).toBeUndefined()
  })

  test("active portraits require the same officer and server and exclude workers", () => {
    expect(officerSettingsTab(tab, "Chief Architect", "local")).toBe(true)
    expect(officerSettingsTab(tab, "Chief Architect", "remote")).toBe(false)
    expect(officerSettingsTab(tab, "nova", "local")).toBe(false)
    expect(officerSettingsTab({ ...tab, worker: true }, "Chief Architect", "local")).toBe(false)
    expect(officerSettingsTab({ ...tab, agent: undefined }, undefined, "local")).toBe(false)
  })
})
