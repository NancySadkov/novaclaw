import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"
import { SettingsProvider } from "@/context/settings"
import { NotificationRowsV2, RECENT_NOTIFICATIONS_LIMIT } from "@/components/settings-v2/notifications-list"
import type { Notification } from "@/context/notification"
import { languageStub } from "./language-stub"

/**
 * Owner, 2026-09-19: *"Recent notifications should be limited to last 5 and All Notifications
 * button."* The limit is the preview's contract, and it lives in ONE component so the preview and the
 * dialog cannot disagree: `limit` bounds the same rows the dialog renders unbounded.
 */
let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
})

const entry = (index: number): Notification => ({
  type: "toast",
  variant: "success",
  title: `Notice ${index}`,
  description: `Body ${index}`,
  time: index,
  viewed: true,
})

const rows = () => document.querySelectorAll('[data-component="settings-v2-row"]')

function mount(entries: readonly Notification[], limit?: number) {
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <NotificationRowsV2 entries={entries} limit={limit} />
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
}

describe("notification rows", () => {
  test("the bounded preview shows the newest five; the unbounded list keeps every one", () => {
    const entries = Array.from({ length: 9 }, (_, index) => entry(index))

    mount(entries, RECENT_NOTIFICATIONS_LIMIT)
    expect(rows()).toHaveLength(RECENT_NOTIFICATIONS_LIMIT)

    dispose?.()
    host?.remove()
    document.body.innerHTML = ""

    mount(entries)
    expect(rows()).toHaveLength(9)
  })

  test("an empty history says so rather than rendering nothing", () => {
    mount([])
    expect(rows()).toHaveLength(1)
    expect(document.body.textContent).toContain(languageStub.t("settings.health.notifications.empty"))
  })
})
