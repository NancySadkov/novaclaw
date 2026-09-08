import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { PlatformProvider } from "@/context/platform"
import { SettingsNudgesV2 } from "@/components/settings-v2/nudges"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

const t = (key: string) => (en as Record<string, string>)[key] ?? key
const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
const agents = [
  { id: "nova", name: "Nova", mode: "primary", hidden: false },
  { id: "writer", name: "Ada", mode: "all", hidden: false },
] as const

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
})

const settle = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const click = (label: string) => {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)
  if (!button) throw new Error(`no button labelled "${label}"`)
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

const typeInto = (selector: string, value: string) => {
  const field = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
  if (!field) throw new Error(`no field matching ${selector}`)
  field.value = value
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

const mount = () => {
  const [store, setStore] = createStore<{ config: Record<string, unknown> }>({ config: {} })
  const sync = () => ({
    data: store,
    updateConfig: async (patch: Record<string, unknown>) => {
      setStore("config", (current) => ({ ...current, ...patch }))
      return {}
    },
  })
  const global = {
    servers: { list: () => [connection], health: {} },
    ensureServerCtx: () => ({ agents: { list: () => agents } }),
  }
  const server = { current: connection, key: "server" }
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={global as never}>
              <ServerContext.Provider value={server as never}>
                <ServerSyncContext.Provider value={sync as never}>
                  <DialogProvider>
                    <SettingsNudgesV2 />
                  </DialogProvider>
                </ServerSyncContext.Provider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  return () => store.config
}

describe("Settings Nudges", () => {
  test("shows shipped defaults and saves a new nudge narrowed to one colleague", async () => {
    const config = mount()
    await settle()

    expect(document.body.textContent).toContain("Protect work when resources run low")
    expect(document.body.textContent).toContain("Check JavaScript time conversions")
    click(t("settings.nudges.add"))
    await settle()
    typeInto(`input[placeholder="${t("settings.nudges.field.name")}"]`, "Review writes")
    typeInto(`input[placeholder="${t("settings.nudges.field.pattern")}"]`, "write\\(")
    typeInto(`textarea[placeholder="${t("settings.nudges.field.text")}"]`, "Check the output path.")
    click("Ada")
    click(t("common.save"))
    await settle()

    const saved = config().nudges as Array<{ name: string; agents?: string[] }>
    expect(saved).toHaveLength(3)
    expect(saved.at(-1)?.name).toBe("Review writes")
    expect(saved.at(-1)?.agents).toEqual(["writer"])
    expect(document.querySelector('[data-component="settings-nudges-editor"]')).toBeNull()
  })
})
