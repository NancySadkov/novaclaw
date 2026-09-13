import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { MemoryGraphPage } from "@/pages/memory-graph"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { ServerContext } from "@/context/server"
import type { MemoryGraph, MemoryRow } from "@/utils/memory-api"

const row = (id: string, kind = "passage", text = `Memory ${id}`): MemoryRow => ({
  id,
  kind,
  text,
  name: "New session",
  scope: "agent:daedalus",
  source: "chat",
  confidence: null,
  relation: "about",
  status: "active",
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
})

const complete = (nodes: readonly MemoryRow[]): MemoryGraph => ({
  nodes,
  edges: [],
  slice: { partial: false, total: nodes.length, returned: nodes.length, omitted: 0, reason: "complete" },
})

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined
let originalFetch: typeof fetch
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext
let originalResizeObserver: unknown
let requests: { url: string; body?: Record<string, unknown> }[] = []

const settle = async (turns = 6) => {
  for (let index = 0; index < turns; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  requests = []
  originalFetch = globalThis.fetch
  originalRect = HTMLElement.prototype.getBoundingClientRect
  originalGetContext = HTMLCanvasElement.prototype.getContext
  originalResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON: () => ({}) }) as DOMRect
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe() {
      this.callback()
    }
    disconnect() {}
    unobserve() {}
  }
})

afterEach(() => {
  dispose?.()
  host?.remove()
  dispose = undefined
  host = undefined
  document.body.innerHTML = ""
  globalThis.fetch = originalFetch
  HTMLElement.prototype.getBoundingClientRect = originalRect
  HTMLCanvasElement.prototype.getContext = originalGetContext
  ;(globalThis as Record<string, unknown>).ResizeObserver = originalResizeObserver
})

function mount(answer: MemoryGraph | Error, options: { diagnosisProblem?: boolean; owner?: string } = {}) {
  host = document.createElement("div")
  host.style.width = "900px"
  host.style.height = "600px"
  document.body.appendChild(host)
  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ url, body })
    if (url.includes("world-memory/graph")) {
      if (answer instanceof Error) throw answer
      return Response.json(answer)
    }
    if (url.includes("world-memory/captions")) {
      const clusters = (body?.clusters ?? []) as { id: string }[]
      const memories = (body?.memories ?? []) as string[]
      return Response.json({
        status: "generated",
        clusters: clusters.map((cluster, index) => ({ id: cluster.id, label: `Memory region ${index + 1}` })),
        memories: memories.map((id) => ({ id, label: `Remembered ${id}` })),
      })
    }
    if (url.includes("diagnosis"))
      return Response.json({
        overall: options.diagnosisProblem ? "problem" : "ok",
        headline: "",
        signals: options.diagnosisProblem
          ? [{ id: "world-memory", label: "Agent memory", status: "problem", detail: "Snapshot could not open" }]
          : [],
      })
    if (url.includes("memory/protection")) {
      const ids = (body?.ids ?? []) as string[]
      return Response.json(ids.map((id) => ({ id, protected: false })))
    }
    if (url.includes("usage/detail")) return Response.json({ usage: null, accesses: [] })
    return Response.json([])
  }) as typeof fetch

  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({
      agents: { list: () => [], loading: () => false, error: () => undefined, refetch: () => {} },
      sync: { data: { path: { directory: "/tmp/project", home: "/tmp/home" } } },
    }),
  }
  const languageStub = {
    t: (key: string) => key,
    plural: (key: string) => key,
    locale: () => "en",
    setLocale: () => {},
  }
  const history = createMemoryHistory()
  history.set({
    value: `/?owner=${encodeURIComponent(options.owner ?? "agent:daedalus")}`,
    replace: true,
    scroll: false,
  })
  dispose = render(
    () => (
      <MemoryRouter history={history}>
        <Route
          path="/"
          component={() => (
            <LanguageContext.Provider value={languageStub as never}>
              <GlobalContext.Provider value={globalStub as never}>
                <ServerContext.Provider value={{ current: connection } as never}>
                  <DialogProvider>
                    <MemoryGraphPage />
                  </DialogProvider>
                </ServerContext.Provider>
              </GlobalContext.Provider>
            </LanguageContext.Provider>
          )}
        />
      </MemoryRouter>
    ),
    host,
  )
}

describe("memory atlas", () => {
  test("renders all 504 legacy passage memories instead of an empty cabinet", async () => {
    mount(complete(Array.from({ length: 504 }, (_, index) => row(`p${index}`))))
    await settle()

    expect(document.querySelector('[data-slot="memory-space"]')?.getAttribute("data-state")).toBe("ready")
    expect(document.querySelector('[data-slot="memory-title"]')?.textContent).toBe("Daedalus")
    expect(document.body.textContent).toContain("504")
    const passage = document.querySelector('button[data-kind="passage"]')
    expect(passage?.getAttribute("aria-pressed")).toBe("true")
    expect(passage?.textContent).toContain("504")
  })

  test("opens a bounded, functional index when 3D is unavailable", async () => {
    mount(complete(Array.from({ length: 150 }, (_, index) => row(`p${index}`))))
    await settle()
    expect(document.querySelector('[data-slot="memory-renderer-fallback"]')).not.toBeNull()
    ;(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Open index",
      ) as HTMLButtonElement
    ).click()
    await settle(2)
    expect(document.querySelectorAll("[data-memory-id]")).toHaveLength(120)
    expect(document.body.textContent).toContain("Showing the first 120 of 150")
  })

  test("search covers passages and opens the matching index", async () => {
    mount(complete([row("one", "passage", "blue comet"), row("two", "claim", "gold moon")]))
    await settle()
    const input = document.querySelector('input[type="search"]') as HTMLInputElement
    input.value = "comet"
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await settle(2)

    expect(document.querySelector('[data-slot="memory-search-count"]')?.textContent).toBe("1")
    expect(document.querySelectorAll("[data-memory-id]")).toHaveLength(1)
    expect(document.body.textContent).toContain("blue comet")
  })

  test("a read fault is never presented as an empty cabinet", async () => {
    mount(new TypeError("connection refused"))
    await settle()

    expect(document.querySelector('[data-slot="memory-space"]')?.getAttribute("data-state")).toBe("unavailable")
    expect(document.body.textContent).toContain("Memory is unavailable right now")
    expect(document.body.textContent).not.toContain("Nothing remembered yet")
    expect(document.querySelector('[data-slot="memory-graph-retry"]')).not.toBeNull()
  })

  test("a degraded empty response is diagnosed before claiming emptiness", async () => {
    mount(complete([]), { diagnosisProblem: true })
    await settle()

    expect(document.querySelector('[data-slot="memory-space"]')?.getAttribute("data-state")).toBe("unavailable")
    expect(document.body.textContent).toContain("Snapshot could not open")
  })

  test("the route owner remains the authority before the roster loads", async () => {
    mount(complete([row("one")]), { owner: "agent:daedalus" })
    await settle()
    const request = requests.find((entry) => entry.url.includes("world-memory/graph"))
    expect(request?.body).toMatchObject({ scopes: ["agent:daedalus"], limit: 5000 })
  })

  test("zoom controls cross the atlas, systems, and memories levels", async () => {
    mount(complete([row("one")]))
    await settle()
    const level = () => document.querySelector('[data-slot="memory-detail-level"]')?.getAttribute("data-level")
    const zoomIn = document.querySelector('button[aria-label="Zoom in"]') as HTMLButtonElement
    expect(level()).toBe("atlas")
    zoomIn.click()
    zoomIn.click()
    await settle(2)
    expect(level()).toBe("systems")
    zoomIn.click()
    zoomIn.click()
    zoomIn.click()
    await settle(2)
    expect(level()).toBe("memories")
    expect(document.querySelectorAll(".memory-space-label").length).toBeGreaterThan(0)
    expect(document.body.textContent).toContain("Remembered one")
  })

  test("semantic region captions float over an unlinked cabinet", async () => {
    mount(complete(Array.from({ length: 90 }, (_, index) => row(`p${index}`, "passage", `Trip detail ${index}`))))
    await settle(10)

    expect(document.body.textContent).toContain("Memory region 1")
    expect(document.querySelector(".memory-space-label-cluster")).not.toBeNull()
    const request = requests.find((entry) => entry.url.includes("world-memory/captions"))
    expect(request?.body).toMatchObject({ scope: "agent:daedalus" })
  })

  test("selecting an indexed memory opens readable details", async () => {
    mount(complete([row("one", "passage", "A complete remembered sentence")]))
    await settle()
    ;(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Open index",
      ) as HTMLButtonElement
    ).click()
    await settle(2)
    ;(document.querySelector('[data-memory-id="one"]') as HTMLButtonElement).click()
    await settle()

    expect(document.querySelector('[data-slot="memory-graph-detail"]')).not.toBeNull()
    expect(document.body.textContent).toContain("A complete remembered sentence")
    expect(document.body.textContent).toContain("This officer's cabinet")
  })
})
