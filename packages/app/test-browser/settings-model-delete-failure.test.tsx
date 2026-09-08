import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { toasterV2 } from "@novaclaw/ui/v2/toast-v2"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { ModelsContext } from "@/context/models"
import { PlatformProvider } from "@/context/platform"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { SettingsModelsV2 } from "@/components/settings-v2/models"
import { ToastRegion } from "@/utils/toast"
import { dict as en } from "@/i18n/en"
import { languageStub } from "./language-stub"

/**
 * **A refused delete must say so** (v0.2.0 ruling 2: a failed mutation never reports success, and a
 * subsystem that cannot answer names itself instead of going quiet).
 *
 * 🔴 The Models tab ended its delete at `.catch(() => false)`. The row correctly stayed — a local
 * hide after a server refusal is the per-browser illusion the delete was rewritten to remove — but
 * nothing else happened at all. Having answered a destructive confirm, the user was left unable to
 * tell "the delete failed" from "the button is broken", and the model they thought they had pruned
 * was still there for every agent, device and headless instance.
 *
 * ⚠️ Both halves are asserted, because each alone passes against a different wrong fix. A panel that
 * always toasted and always kept the row would satisfy the failure case; a panel that always removed
 * the row would satisfy the control.
 */


let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  // ⚠️ The toaster is a process-wide Kobalte singleton, so emptying the DOM is not enough: the next
  // `ToastRegion` renders the queue again and the previous test's failure message reappears under the
  // next test's assertions. Caught by the control here, which asserted the ABSENCE of that message.
  toasterV2.clear()
})

const MODEL = {
  id: "test-model",
  name: "Test Model",
  api: { id: "test-model" },
  limit: { context: 131072, output: 8192 },
  variants: [] as unknown[],
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  provider: { id: "local", name: "Local", api: "openai" },
}

function mount(options: { removeFails: boolean }) {
  const calls = { remove: 0 }
  const [store, setStore] = createStore<{ models: (typeof MODEL)[] }>({ models: [MODEL] })

  const models = {
    list: () => store.models,
    // The CLIENT hide. The whole point of the fix is that it must not run after a refusal.
    remove: (key: { providerID: string; modelID: string }) =>
      setStore("models", (prev) => prev.filter((m) => !(m.provider.id === key.providerID && m.id === key.modelID))),
    visible: () => true,
    setVisibility: () => {},
    tier: { get: () => "guess", set: () => {} },
  }

  const sdk = {
    client: {
      path: { get: async () => ({ data: { directory: "/tmp/models", home: "/home/tester" } }) },
      v2: {
        provider: {
          removeModel: async () => {
            calls.remove++
            if (options.removeFails) throw new Error("the instance refused")
            return {}
          },
        },
      },
    },
  }

  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  const sync = () => ({
    data: { config: {}, path: { directory: "/tmp/models", home: "/home/tester" } },
    updateConfig: async () => ({}),
  })
  const serverCtx = { sdk, sync: { data: { directory: "/tmp/models", home: "/home/tester" } } }
  const globalStub = { servers: { list: () => [connection] }, ensureServerCtx: () => serverCtx }

  // ⚠️ Cleared on the way IN as well as out. The toaster is a process-wide Kobalte singleton with a
  // queue LIMIT, and the gate runs every file in this directory in one process — so toasts left by
  // another panel's tests fill the region and this one's message is queued but never rendered. Per-file
  // green said nothing about that; only the whole-directory run did.
  toasterV2.clear()
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={{ current: connection } as never}>
                <ServerSyncContext.Provider value={sync as never}>
                  <ModelsContext.Provider value={models as never}>
                    <DialogProvider>
                      <SettingsModelsV2 />
                      <ToastRegion />
                    </DialogProvider>
                  </ModelsContext.Provider>
                </ServerSyncContext.Provider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  return { calls, rows: () => store.models }
}

const settle = async (times = 12) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }))

/** The row's trash button, then the destructive confirm the panel stacks over Settings. */
const deleteTheModel = async () => {
  const trash = document.querySelector(`[aria-label="${en["settings.models.remove.confirm.action"]}"]`)
  if (!trash) throw new Error("no delete button on the model row")
  click(trash)
  await settle()
  const confirmButton = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === en["settings.models.remove.confirm.action"],
  )
  if (!confirmButton) throw new Error("the destructive confirm did not open")
  click(confirmButton)
  await settle()
}

const rowNames = () => [...document.querySelectorAll('[data-slot="settings-v2-row-title"]')].map((n) => n.textContent)

describe("a failed model delete", () => {
  test("is named on screen, and the row stays", async () => {
    const { calls, rows } = mount({ removeFails: true })
    await settle()
    expect(rowNames()).toContain(MODEL.name)

    await deleteTheModel()

    expect(calls.remove).toBe(1)
    // The row is still there — a local hide over a server refusal is the illusion this must not create.
    expect(rows()).toHaveLength(1)
    expect(rowNames()).toContain(MODEL.name)
    // …and the failure is REPORTED, naming the model and carrying the instance's own reason.
    expect(document.body.textContent).toContain("Could not remove Test Model")
    expect(document.body.textContent).toContain("the instance refused")
  })

  test("the control: a delete the instance accepts removes the row and says nothing", async () => {
    const { calls, rows } = mount({ removeFails: false })
    await settle()

    await deleteTheModel()

    expect(calls.remove).toBe(1)
    expect(rows()).toHaveLength(0)
    expect(rowNames()).not.toContain(MODEL.name)
    expect(document.body.textContent).not.toContain("Could not remove")
  })
})
