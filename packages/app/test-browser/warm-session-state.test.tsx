import { afterEach, expect, test } from "bun:test"
import { createSignal, getOwner, onCleanup, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { PlatformProvider } from "@/context/platform"
import { ServerSyncContext } from "@/context/server-sync"
import { ModelsProvider, useModels } from "@/context/models"
import { SessionScopeProvider, useResolvedSessionID } from "@/context/session-scope"
import { createTabMemory } from "@/context/tab-memory"
import { ServerScope } from "@/utils/server-scope"
import { ServerConnection } from "@/context/server"
import { createTabPromptState, selectPromptTab } from "@/context/prompt"
import { tabKey, type Tab } from "@/context/tabs"

let dispose: (() => void) | undefined
let host: HTMLDivElement
afterEach(() => {
  dispose?.()
  host?.remove()
})
const mount = (view: () => import("solid-js").JSX.Element) => {
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <PlatformProvider value={{ platform: "web" } as never}>{view()}</PlatformProvider>, host)
}

test("model history never suspends a warm chat while desktop storage is pending", async () => {
  const reads: Array<(value: string | null) => void> = []
  const storage = {
    getItem: () => new Promise<string | null>((resolve) => reads.push(resolve)),
    setItem: async () => {},
    removeItem: async () => {},
    clear: async () => {},
    key: async () => null,
    getLength: async () => 0,
    length: Promise.resolve(0),
  }
  const sync = () => ({ scope: ServerScope.local, data: { config: {} } }) as never
  const Probe = () => {
    const models = useModels()
    return (
      <div>
        Ready chat:{" "}
        {models.recent
          .list()
          .map((model) => model.modelID)
          .join(",")}
      </div>
    )
  }
  mount(() => (
    <MemoryRouter>
      <Route
        path="/"
        component={() => (
          <PlatformProvider value={{ platform: "desktop", storage: () => storage } as never}>
            <ServerSyncContext.Provider value={sync}>
              <Suspense fallback={<div>Loading</div>}>
                <ModelsProvider>
                  <Probe />
                </ModelsProvider>
              </Suspense>
            </ServerSyncContext.Provider>
          </PlatformProvider>
        )}
      />
    </MemoryRouter>
  ))
  expect(host.textContent).toContain("Ready chat:")
  expect(host.textContent).not.toContain("Loading")
  expect(reads.length).toBeGreaterThan(0)
  for (const resolve of reads)
    resolve(JSON.stringify({ user: [], recent: [{ providerID: "local", modelID: "saved" }], variant: {} }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toContain("Ready chat: saved")
})

test("officer session changes are synchronous and preloaded drafts stay separate", () => {
  const server = ServerConnection.Key.make("warm-test")
  const first: Tab = { type: "agent", server, agent: "iris" }
  const second: Tab = { type: "agent", server, agent: "lyra" }
  let setSession!: (id: string) => void
  const Probe = () => {
    const session = useResolvedSessionID()
    return <span>{session()}</span>
  }
  mount(() => (
    <MemoryRouter>
      <Route
        path="/"
        component={() => {
          const [session, update] = createSignal("ses_iris")
          setSession = update
          const memory = createTabMemory(getOwner())
          onCleanup(memory.dispose)
          const tabs = {
            state: <T,>(tab: Tab, name: string, init: () => T, identity?: string) =>
              memory.ensure(tabKey(tab), name, init, identity),
          } as Parameters<typeof createTabPromptState>[0]
          const preload = (tab: Tab, id: string) =>
            createTabPromptState(tabs, tab, ServerScope.local, { dir: "warm-folder", id })
          const iris = preload(first, "ses_iris")
          iris.set([{ type: "text", content: "Iris draft", start: 0, end: 10 }])
          const lyra = preload(second, "ses_lyra")
          lyra.set([{ type: "text", content: "Lyra draft", start: 0, end: 10 }])
          expect(selectPromptTab([first, second], { dir: "warm-folder", id: "ses_iris" }, server, "iris")).toBe(first)
          expect(preload(first, "ses_iris")).toBe(iris)
          expect(preload(second, "ses_lyra")).toBe(lyra)
          expect(preload(first, "ses_fresh").current()[0]).toMatchObject({ type: "text", content: "" })
          expect(preload(second, "ses_lyra").current()[0]).toMatchObject({ type: "text", content: "Lyra draft" })
          return (
            <SessionScopeProvider value={{ sessionID: session, refresh: () => {} }}>
              <Probe />
            </SessionScopeProvider>
          )
        }}
      />
    </MemoryRouter>
  ))
  expect(host.textContent).toBe("ses_iris")
  setSession("ses_lyra")
  expect(host.textContent).toBe("ses_lyra")
})
