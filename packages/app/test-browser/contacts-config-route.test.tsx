import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { ContactsPage } from "@/pages/contacts"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
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
  personality: "Precise and dry.",
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

/** Memory's Back target is not just a pretty URL: Contacts consumes it and opens that colleague's
 * real Configure dialog. Closing the dialog also consumes the instruction, so it stays closed. */
test("the addressable configure route reopens the selected colleague", async () => {
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
  }
  const session = { data: { info: {}, session_status: {}, session_live: () => undefined } }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({
      agents,
      sdk,
      sync: { data: { path: { directory: "/tmp/p", home: "/tmp" } }, session },
    }),
  }
  const syncStub = () => ({
    data: { path: { directory: "/tmp/p", home: "/tmp" } },
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
  const modelsStub = { list: () => [], connected: () => true }
  const tabsStub = { closeSessionTab: () => {}, store: [] as never[] }

  const originalFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  }

  const history = createMemoryHistory()
  history.set({ value: "/?configure=theron", replace: true, scroll: false })
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <MemoryRouter history={history}>
          <Route
            path="/"
            component={() => (
              <SettingsProvider>
                <LanguageContext.Provider value={languageStub as never}>
                  <GlobalContext.Provider value={globalStub as never}>
                    <ServerContext.Provider value={{ current: connection } as never}>
                      <ServerSyncContext.Provider value={syncStub as never}>
                        <ModelsContext.Provider value={modelsStub as never}>
                          <TabsContext.Provider value={tabsStub as never}>
                            <DialogProvider>
                              <ContactsPage />
                            </DialogProvider>
                          </TabsContext.Provider>
                        </ModelsContext.Provider>
                      </ServerSyncContext.Provider>
                    </ServerContext.Provider>
                  </GlobalContext.Provider>
                </LanguageContext.Provider>
              </SettingsProvider>
            )}
          />
        </MemoryRouter>
      </PlatformProvider>
    ),
    host,
  )
  await settle()

  expect(document.querySelector('[data-action="agent-config-back"]')).not.toBeNull()
  expect(document.body.textContent).toContain("Theron")
  ;(document.querySelector('[data-action="agent-config-back"]') as HTMLButtonElement).click()
  await settle()
  expect(history.get()).toBe("/")
})
