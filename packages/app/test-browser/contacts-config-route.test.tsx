import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { ContactsPage } from "@/pages/contacts"
import { AgentSettingsPage } from "@/pages/agent-settings"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { NotificationContext } from "@/context/notification"
import { ServerSyncContext } from "@/context/server-sync"
import { ModelsContext } from "@/context/models"
import { TabsContext } from "@/context/tabs"
import { LanguageContext } from "@/context/language"
import { SettingsProvider } from "@/context/settings"
import { PlatformProvider } from "@/context/platform"

const AGENT = {
  id: "theron",
  name: "Theron",
  title: "Bookkeeper",
  memory: "own" as const,
  mode: "primary" as const,
  hidden: false,
  config: {},
}

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined
let restoreFetch: (() => void) | undefined

afterEach(() => {
  dispose?.()
  host?.remove()
  document.body.innerHTML = ""
  restoreFetch?.()
  dispose = undefined
  host = undefined
  restoreFetch = undefined
})

const settle = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Settings is a real screen with a stable address. Back returns to the explicit source route
 * instead of closing a modal whose ownership depended on whichever page happened to be beneath it. */
test("the addressable settings screen opens the selected colleague and returns to its source", async () => {
  host = document.createElement("div")
  document.body.appendChild(host)

  const connection = {
    type: "http",
    url: "http://localhost:4096",
    http: { url: "http://localhost:4096" },
  }
  const agents = {
    list: () => [AGENT],
    loading: () => false,
    error: () => undefined,
    refetch: () => {},
  }
  const sdk = {
    client: {
      v2: {
        session: { list: async () => ({ data: { data: [] } }) },
        agent: { usageMany: async () => ({ data: { data: {} } }) },
      },
    },
    server: { http: connection.http },
    event: { listen: () => () => {} },
  }
  const session = {
    data: { info: {}, session_status: {}, session_live: () => undefined, session_working: () => false },
  }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({
      agents,
      sdk,
      sync: { data: { path: { directory: "/tmp/p", home: "/tmp" } }, session },
    }),
  }
  const syncStub = () => ({
    data: { path: { directory: "/tmp/p", home: "/tmp" }, config: {} },
    session,
    updateConfig: async () => {},
    removeConfig: async () => {},
  })
  const languageStub = {
    t: (key: string) => key,
    plural: (group: string) => group,
    locale: () => "en",
    setLocale: () => {},
  }
  const modelsStub = { list: () => [], connected: () => true, enabled: () => true }
  const tabsStub = { closeSessionTab: () => {}, store: [] as never[] }
  const notificationStub = { session: { unseenSessionIds: () => [] } }

  const originalFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  }

  const history = createMemoryHistory()
  history.set({ value: "/officers/theron/settings?returnTo=/tasks", replace: true, scroll: false })
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <QueryClientProvider client={new QueryClient()}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={{ current: connection } as never}>
                <ServerSDKProvider>
                <NotificationContext.Provider value={notificationStub as never}>
                <ServerSyncContext.Provider value={syncStub as never}>
                  <ModelsContext.Provider value={modelsStub as never}>
                    <TabsContext.Provider value={tabsStub as never}>
                      <DialogProvider>
                        <MemoryRouter history={history}>
                          <Route path="/tasks" component={ContactsPage} />
                          <Route path="/officers/:agentID/settings" component={AgentSettingsPage} />
                        </MemoryRouter>
                      </DialogProvider>
                    </TabsContext.Provider>
                  </ModelsContext.Provider>
                </ServerSyncContext.Provider>
                </NotificationContext.Provider>
                </ServerSDKProvider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
        </QueryClientProvider>
      </PlatformProvider>
    ),
    host,
  )
  await settle()

  expect(document.querySelector('[data-action="agent-config-back"]')).not.toBeNull()
  expect(document.body.textContent).toContain("Theron")
  ;(document.querySelector('[data-action="agent-config-back"]') as HTMLButtonElement).click()
  await settle()
  expect(history.get()).toBe("/tasks")
})

test("officer tiles reorder from the keyboard and open their actions by right click or touch hold", async () => {
  host = document.createElement("div")
  document.body.appendChild(host)

  const connection = {
    type: "http",
    url: "http://localhost:4096",
    http: { url: "http://localhost:4096" },
  }
  const roster = [
    { ...AGENT, id: "nova", name: "Nova", title: "CEO" },
    { ...AGENT, id: "aris", name: "Aris" },
    { ...AGENT, id: "theron", name: "Theron" },
  ]
  const agents = {
    list: () => roster,
    loading: () => false,
    error: () => undefined,
    refetch: () => {},
  }
  const workerReads: string[] = []
  const sdk = {
    client: {
      v2: {
        session: {
          list: async () => ({ data: { data: [
            { id: "ses_theron", agent: "theron", type: "interactive", location: { directory: "/tmp/p" }, time: { created: Date.now() } },
            ...[1, 2, 3, 4].map((index) => ({ id: `ses_finished_${index}`, parentID: "ses_theron", type: "sub-agent", time: { created: Date.now() } })),
          ] } }),
          worker: { list: async ({ sessionID }: { sessionID: string }) => { workerReads.push(sessionID); return { data: { data: [] } } } },
        },
        agent: { usageMany: async () => ({ data: { data: {} } }) },
      },
    },
    server: { http: connection.http },
    event: { listen: () => () => {} },
  }
  const session = {
    data: {
      info: {},
      session_status: {},
      session_live: () => undefined,
      session_working: () => false,
    },
  }
  const [config, setConfig] = createStore({ officer_order: ["theron", "aris"] })
  const writes: unknown[] = []
  const syncStub = () => ({
    data: { config, path: { directory: "/tmp/p", home: "/tmp" } },
    session,
    updateConfig: async (patch: { officer_order?: string[] }) => {
      writes.push(structuredClone(patch))
      if (patch.officer_order) setConfig("officer_order", patch.officer_order)
    },
    refetchConfig: async () => ({}),
    removeConfig: async () => {},
  })
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({
      agents,
      sdk,
      sync: { data: { path: { directory: "/tmp/p", home: "/tmp" } }, session },
    }),
  }
  const languageStub = {
    t: (key: string) => key,
    plural: (group: string) => group,
    locale: () => "en",
    setLocale: () => {},
  }
  const tabsStub = { closeSessionTab: () => {}, store: [] as never[] }
  const notificationStub = { session: { unseenSessionIds: () => ["ses_theron", "ses_finished_1"] } }

  const originalFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  }

  const history = createMemoryHistory()
  history.set({ value: "/tasks", replace: true, scroll: false })
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <QueryClientProvider client={new QueryClient()}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={{ current: connection } as never}>
                <ServerSDKProvider>
                <NotificationContext.Provider value={notificationStub as never}>
                <ServerSyncContext.Provider value={syncStub as never}>
                  <TabsContext.Provider value={tabsStub as never}>
                    <DialogProvider>
                      <MemoryRouter history={history}>
                        <Route path="/tasks" component={ContactsPage} />
                      </MemoryRouter>
                    </DialogProvider>
                  </TabsContext.Provider>
                </ServerSyncContext.Provider>
                </NotificationContext.Provider>
                </ServerSDKProvider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
        </QueryClientProvider>
      </PlatformProvider>
    ),
    host,
  )
  await settle(12)

  const ids = () => [...document.querySelectorAll<HTMLElement>("[data-contact-id]")].map((row) => row.dataset.contactId)
  expect(ids()).toEqual(["nova", "theron", "aris"])
  expect(workerReads).toContain("ses_theron")
  expect(document.querySelector('[data-contact-id="theron"] [data-action="contacts-workers"]')).toBeNull()
  expect(document.querySelector('[data-contact-id="theron"] [data-slot="officer-response-badge"]')?.textContent).toBe("1")
  expect(document.querySelector('[data-contact-id="aris"] [data-slot="officer-response-badge"]')).toBeNull()
  expect(document.querySelector('[data-contact-id="nova"] [data-action="contacts-reorder"]')).toBeNull()

  let tile = document.querySelector<HTMLElement>('[data-contact-id="theron"]')!
  tile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }))
  await settle(12)

  expect(writes).toEqual([{ officer_order: ["aris", "theron"] }])
  expect(config.officer_order).toEqual(["aris", "theron"])
  expect(ids()).toEqual(["nova", "aris", "theron"])
  tile = document.querySelector<HTMLElement>('[data-contact-id="theron"]')!

  tile.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 }),
  )
  await settle()
  const menu = document.querySelector('[role="menu"]')!
  expect(menu).not.toBeNull()
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    "command.category.settings",
    "agentConfig.pause",
    "agentConfig.clone",
    "agentConfig.retire",
  ])
  tile.click()
  expect(history.get()).toBe("/tasks")
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await settle()
  tile.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 }),
  )
  await new Promise((resolve) => setTimeout(resolve, 750))
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "touch" }))
  expect(writes).toHaveLength(1)
})
