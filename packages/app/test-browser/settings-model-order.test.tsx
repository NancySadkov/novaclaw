import { afterEach, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { ModelsContext } from "@/context/models"
import { PlatformProvider } from "@/context/platform"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { SettingsModelsV2 } from "@/components/settings-v2/models"
import { languageStub } from "./language-stub"

const model = (id: string, name: string, released: number) => ({
  id,
  name,
  api: { id },
  limit: { context: 131072, output: 8192 },
  variants: [] as unknown[],
  time: { released },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  provider: { id: "local", name: "Local", api: "openai" },
})

const MODELS = [model("alpha", "Alpha", 2), model("beta", "Beta", 1)]
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test("marks the effective default and saves keyboard reordering through instance config", async () => {
  const writes: unknown[] = []
  const [config, setConfig] = createStore<{ model: string; model_order: string[] }>({
    model: "local/alpha",
    model_order: [],
  })
  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  const sdk = { client: { path: { get: async () => ({ data: { directory: "/tmp/models" } }) }, v2: {} } }
  const sync = () => ({
    data: { config, path: { directory: "/tmp/models" } },
    updateConfig: async (patch: { model_order?: string[] }) => {
      writes.push(structuredClone(patch))
      if (patch.model_order) setConfig("model_order", patch.model_order)
    },
    refetchConfig: async () => ({}),
    refetchProviders: async () => ({ models: new Map([["local", MODELS]]) }),
  })
  const models = {
    list: () => MODELS,
    remove: () => {},
    enabled: () => true,
    setEnabled: async () => {},
    tier: { get: () => "guess", set: () => {} },
  }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({ sdk, sync: { data: { path: { directory: "/tmp/models" } } } }),
  }

  const host = document.createElement("div")
  document.body.append(host)
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
  await settle()

  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-component="settings-v2-model-sortable"]')]
  // The reorder control's own text: the row title ALSO carries the live t/s readout, which is not
  // part of the model's name (added 2026-09-16).
  const rowLabel = (row: HTMLElement) => row.querySelector(".settings-v2-models-drag-target")?.textContent
  expect(rows().map(rowLabel)).toEqual(["AlphaDefault", "Beta"])
  expect(document.querySelector('[data-default="true"]')?.textContent).toContain("Alpha")

  const handle = document.querySelector<HTMLButtonElement>('button[aria-label="Reorder Alpha"]')!
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  await settle()

  expect(writes).toEqual([{ model_order: ["local/beta", "local/alpha"] }])
  expect(config.model_order).toEqual(["local/beta", "local/alpha"])
  expect(rows().map(rowLabel)).toEqual(["Beta", "AlphaDefault"])
  // Reordering changes presentation only; the default remains Alpha and moves with its row.
  expect(document.querySelector('[data-default="true"]')?.textContent).toContain("Alpha")
})
