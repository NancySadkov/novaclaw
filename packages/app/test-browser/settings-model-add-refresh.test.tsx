import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
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
import { languageStub } from "./language-stub"

const MODEL_ID = "model-with-a-long-id-that-must-survive-refresh"
const PROVIDER_ID = "models-example-v1"
const MODEL = {
  id: MODEL_ID,
  name: MODEL_ID,
  api: { id: MODEL_ID },
  limit: { context: 131072, output: 8192 },
  variants: [] as unknown[],
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  provider: {
    id: PROVIDER_ID,
    name: "https://models.example/v1/a/very/long/endpoint",
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://models.example/v1" },
  },
}

let dispose: (() => void) | undefined
let restoreFetch: typeof globalThis.fetch | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  toasterV2.clear()
  if (restoreFetch) globalThis.fetch = restoreFetch
  restoreFetch = undefined
})

const settle = async (times = 12) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const click = (node: Element) => node.dispatchEvent(new MouseEvent("click", { bubbles: true }))
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)
const mustButton = (name: string) => {
  const found = button(name)
  if (!found)
    throw new Error(
      `missing button ${name}; saw: ${[...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).join(" | ")}`,
    )
  return found
}
const fill = (label: string, value: string) => {
  const node = document.querySelector<HTMLInputElement>(`input[placeholder="http://localhost:8000/v1"]`)
  if (!node) throw new Error(`missing ${label}`)
  node.value = value
  node.dispatchEvent(new Event("input", { bubbles: true }))
}

function mount(options: { refreshFails?: boolean }) {
  const calls = { write: 0, refresh: 0 }
  const [catalog, setCatalog] = createStore<{ models: (typeof MODEL)[] }>({ models: [] })
  const [entered, setEntered] = createSignal(true)
  const models = {
    list: () => catalog.models,
    remove: () => {},
    visible: () => true,
    setVisibility: () => {},
    tier: { get: () => "guess", set: () => {} },
  }
  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  const sdk = { client: { path: { get: async () => ({ data: { directory: "/tmp/models" } }) }, v2: {} } }
  const sync = () => ({
    data: { config: {}, path: { directory: "/tmp/models" } },
    updateConfig: async () => {
      calls.write++
    },
    refetchProviders: async () => {
      calls.refresh++
      if (options.refreshFails) throw new Error("catalog refresh unavailable")
      setCatalog("models", [MODEL])
      return { models: new Map([[PROVIDER_ID, [MODEL]]]) }
    },
  })
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({ sdk, sync: { data: { path: { directory: "/tmp/models" } } } }),
  }

  restoreFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/presets")) return new Response("{}", { status: 200 })
    if (url.pathname.endsWith("/local-model/status")) return new Response("{}", { status: 200 })
    if (url.pathname.includes("/provider/") && url.pathname.endsWith("/probe")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { baseURL?: string }
      const result =
        body.baseURL === "https://models.example/v1"
          ? { status: "ok", models: [MODEL_ID], limits: { [MODEL_ID]: { context: 131072, output: 8192 } } }
          : { status: "unreachable" }
      return new Response(JSON.stringify(result), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }) as typeof globalThis.fetch

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
                      <button onClick={() => setEntered(false)}>Leave settings</button>
                      <button onClick={() => setEntered(true)}>Re-enter settings</button>
                      <Show when={entered()}>
                        <SettingsModelsV2 />
                      </Show>
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
  return calls
}

async function addModel() {
  await settle()
  click(mustButton("Add models"))
  await settle()
  click(document.querySelector('[data-action="new-model-custom"]')!)
  fill("Endpoint URL", "https://models.example/v1")
  click(mustButton("Find models"))
  await settle()
  click(mustButton("Add selected"))
  await settle()
}

describe("VR-004 · adding models is a verified state transition", () => {
  test("add, refresh, and Settings re-entry all observe the persisted model", async () => {
    const calls = mount({})
    await addModel()

    expect(calls).toEqual({ write: 1, refresh: 1 })
    expect(document.body.textContent).toContain("Models added")
    expect(document.body.textContent).toContain(MODEL_ID)

    click(button("Leave settings")!)
    click(button("Re-enter settings")!)
    await settle()
    expect(document.body.textContent).toContain(MODEL_ID)
    expect(document.body.textContent).not.toContain("No model results")
  })

  test("a failed refresh is neither success nor an empty Models surface", async () => {
    const calls = mount({ refreshFails: true })
    await addModel()

    expect(calls).toEqual({ write: 1, refresh: 1 })
    expect(document.body.textContent).toContain("catalog refresh unavailable")
    expect(document.body.textContent).not.toContain("Models added")
    expect(document.querySelector('[data-component="dialog-v2"]')).not.toBeNull()
  })
})
