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

const mount = (fixedAgentID = "writer") => {
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
                    <SettingsNudgesV2 fixedAgentID={fixedAgentID} />
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

describe("Officer Nudges", () => {
  test("one officer's list, no global scope, and a saved personal nudge", async () => {
    const config = mount()
    await settle()

    // No scope picker: this surface has its officer, and there is no global list anymore.
    expect(document.querySelector('[data-component="select-v2"]')).toBeNull()
    expect(document.body.textContent).not.toContain("Protect work when resources run low")
    expect(document.body.textContent).not.toContain("Check JavaScript time conversions")
    click(t("settings.nudges.add"))
    await settle()
    typeInto(`input[placeholder="${t("settings.nudges.field.name")}"]`, "Review writes")
    typeInto(`input[placeholder="${t("settings.nudges.field.pattern")}"]`, "write\\(")
    typeInto(`textarea[placeholder="${t("settings.nudges.field.text")}"]`, "Check the output path.")
    click(t("common.save"))
    await settle()

    const saved = (config().agents as { writer: { nudges: Array<{ name: string }> } }).writer.nudges
    expect(saved).toHaveLength(1)
    expect(saved[0]?.name).toBe("Review writes")
    expect(document.body.textContent).toContain("Review writes")
    expect(document.querySelector('[data-component="settings-nudges-editor"]')).toBeNull()

    click(t("common.edit"))
    await settle()
    expect(document.querySelector(".nudge-card")).toBeNull()
    expect(document.querySelector('[data-component="settings-nudges-editor"]')).not.toBeNull()
    expect(
      (document.querySelector(`input[placeholder="${t("settings.nudges.field.name")}"]`) as HTMLInputElement).value,
    ).toBe("Review writes")
    typeInto(`textarea[placeholder="${t("settings.nudges.field.text")}"]`, "Check the destination path.")
    click(t("common.save"))
    await settle()
    expect((config().agents as { writer: { nudges: Array<{ text: string }> } }).writer.nudges).toEqual([
      expect.objectContaining({ name: "Review writes", text: "Check the destination path." }),
    ])
    expect(document.querySelector(".nudge-card")).not.toBeNull()
    expect(document.querySelector('[data-component="settings-nudges-editor"]')).toBeNull()
  })
})
