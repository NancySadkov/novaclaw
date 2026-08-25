import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { MemoryGraphPage } from "@/pages/memory-graph"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { LanguageContext } from "@/context/language"
import type { EdgeRow, MemoryGraph, MemoryRow } from "@/utils/memory-api"

/**
 * THE MEMORY APP, RENDERED — the instrument the RAG ledger's P0 gate asks for.
 *
 * 🔴 Why a render and not another source ledger. The two defects this file pins are both invisible to
 * anything that reads the file:
 *
 *   **The empty cabinet.** `memoryGraph(...).catch(() => ({ nodes: [], edges: [] }))` turned every
 *   fault — a dead engine, an expired token, an unreachable instance — into "Nothing remembered yet".
 *   The catch is one line of plausible-looking defensive code; only running it shows what a person
 *   ends up reading.
 *
 *   **The unmeasured canvas.** The viewer drew a fixed 1000x700 plane at scale 1 into whatever box the
 *   flex layout gave it. In a narrow pane the right-hand memories were off-screen with no indication
 *   they existed. Coordinate math alone passes here — `memory-graph/layout.test.ts` did, all along;
 *   what fails is the composition of plane, viewport and transform, which only exists once mounted.
 *
 * ⚠️ Two DOM capabilities happy-dom does not supply are stubbed BELOW rather than worked around:
 * `getBoundingClientRect` (always zeroes, so the canvas would measure 0x0 and never fit) and
 * `ResizeObserver`. Both are seams the test drives, so "the window changed" is something this file can
 * actually do rather than assert about.
 */

// --- the fixture: two connected entities, one lone episode, and a passage hidden by default -----
const node = (id: string, kind: string, name: string | null, scope = "global"): MemoryRow => ({
  id,
  kind,
  text: `${name ?? id} text`,
  name,
  scope,
  source: null,
  confidence: null,
  relation: "about",
})
const NODES: MemoryRow[] = [
  node("e1", "entity", "Nancy"),
  node("e2", "entity", "Symta"),
  node("ep1", "episode", null),
  node("p1", "passage", null),
]
const EDGES: EdgeRow[] = [
  { from: "e1", to: "e2", type: "wrote" },
  { from: "p1", to: "e2", type: "mentions" },
]
const FIXTURE: MemoryGraph = { nodes: NODES, edges: EDGES }

// --- DOM seams ----------------------------------------------------------------------------------
let paneSize = { width: 900, height: 600 }
const resizeCallbacks: (() => void)[] = []
const rect = (width: number, height: number) =>
  ({ x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect

let originalRect: typeof HTMLElement.prototype.getBoundingClientRect
let originalRO: unknown
let restoreFetch: (() => void) | undefined
let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  paneSize = { width: 900, height: 600 }
  resizeCallbacks.length = 0
  originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    // ONLY the graph canvas reports a size; everything else keeps happy-dom's zeroes, so no other
    // code silently starts depending on a measurement this test invented.
    return this.dataset?.slot === "memory-graph-canvas" ? rect(paneSize.width, paneSize.height) : rect(0, 0)
  }
  originalRO = (globalThis as Record<string, unknown>).ResizeObserver
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    constructor(private readonly cb: () => void) {}
    observe() {
      resizeCallbacks.push(this.cb)
    }
    disconnect() {}
    unobserve() {}
  }
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ""
  restoreFetch?.()
  restoreFetch = undefined
  HTMLElement.prototype.getBoundingClientRect = originalRect
  ;(globalThis as Record<string, unknown>).ResizeObserver = originalRO
  // The page CACHES layout positions per instance. Leaking them between tests would seed the next
  // fixture from this one's plane — the vacuous-pass shape, where a later assertion passes because of
  // an earlier test rather than because of the code.
  localStorage.clear()
})

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

/** The non-graph routes this page's siblings call, each in its own shape. */
const sideAnswer = (url: string): unknown => {
  if (url.includes("api/diagnosis")) return { signals: [], ok: true }
  if (url.includes("memory/stats")) return { total: 0, valid: 0 }
  return []
}

/** What each graph fetch answers, in order; the last entry serves every later call. A throw faults it. */
function mount(answers: (() => MemoryGraph)[]) {
  host = document.createElement("div")
  document.body.appendChild(host)
  let call = 0

  // ⚠️ `http` is a `ServerConnection.HttpBase` OBJECT, not a URL string — `instanceFetch` reads
  // `server.url` off it. A string here yields `new URL(route, "undefined/")` and every request throws.
  const connection = { type: "http", url: "http://localhost:4096", http: { url: "http://localhost:4096" } }
  const originalFetch = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    // `instanceFetch` sends a `URL` object; a `Request` would carry `.url`. Reading the wrong one
    // throws INSIDE the stub, and a stub that throws looks exactly like the outage under test.
    const url = typeof input === "string" ? input : ((input as Request).url ?? String(input))
    // The page mounts on the Remembered LIST, which fetches on its own — so the stub has to answer
    // those routes with their real SHAPES. A blanket `[]` made `instanceDiagnosis` return an array,
    // and `health()?.signals.some(...)` threw before the graph was ever reached.
    if (!url.includes("memory/graph")) return json(sideAnswer(url))
    const answer = answers[Math.min(call, answers.length - 1)]!
    call += 1
    // A THROW here rejects the fetch — the transport-outage shape, which is precisely what the page
    // must not render as an empty cabinet.
    return json(answer())
  }) as typeof fetch
  restoreFetch = () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  }

  const agentsCache = { list: () => [], loading: () => false, error: () => undefined, refetch: () => {} }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({ agents: agentsCache, sync: { data: { path: { directory: "/tmp/p" } } } }),
  }
  const syncStub = () => ({ data: { path: { directory: "/tmp/p" } }, session: { data: { info: {} } } })
  const languageStub = { t: (key: string) => key, locale: () => "en", setLocale: () => {} }

  dispose = render(
    () => (
      <MemoryRouter>
        <Route
          path="/"
          component={() => (
            <LanguageContext.Provider value={languageStub as never}>
              <GlobalContext.Provider value={globalStub as never}>
                <ServerContext.Provider value={{ current: connection } as never}>
                  <ServerSyncContext.Provider value={syncStub as never}>
                    <DialogProvider>
                      <MemoryGraphPage />
                    </DialogProvider>
                  </ServerSyncContext.Provider>
                </ServerContext.Provider>
              </GlobalContext.Provider>
            </LanguageContext.Provider>
          )}
        />
      </MemoryRouter>
    ),
    host,
  )
  return host
}

const settle = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const canvas = () => document.querySelector('[data-slot="memory-graph-canvas"]') as HTMLElement | null
const state = () => canvas()?.dataset.state
const bodyText = () => document.body.textContent ?? ""
const showGraph = () => {
  const button = [...document.querySelectorAll('[data-slot="memory-view-switch"]')].find(
    (b) => (b as HTMLElement).dataset.view === "graph",
  ) as HTMLButtonElement | undefined
  button?.click()
}

/** Every drawn node's centre in SCREEN pixels — its plane position through the content transform. */
function drawnPoints(): { x: number; y: number }[] {
  const group = document.querySelector('[data-slot="memory-graph-canvas"] svg > g') as SVGGElement | null
  const parsed = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(group?.getAttribute("transform") ?? "")
  if (!group || !parsed) return []
  const [tx, ty, scale] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
  const marks = [...group.children].filter((el) => el.tagName === "g" && el.hasAttribute("transform"))
  return marks.map((el) => {
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(el.getAttribute("transform")!)!
    return { x: Number(m[1]) * scale + tx, y: Number(m[2]) * scale + ty }
  })
}

const insidePane = (p: { x: number; y: number }) =>
  p.x >= 0 && p.y >= 0 && p.x <= paneSize.width && p.y <= paneSize.height

describe("MemoryGraphPage renders", () => {
  test("the instrument works at all — the graph mounts and draws its visible nodes", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    // Guard on the instrument: if this is wrong every assertion below is vacuous.
    expect(state()).toBe("ready")
    // Three of four — the passage is hidden by default.
    expect(drawnPoints().length).toBe(3)
  })

  test("🔴 a FAULT says unavailable and offers Retry — it never says the cabinet is empty", async () => {
    mount([
      () => {
        throw new TypeError("Failed to fetch")
      },
    ])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("unavailable")
    expect(bodyText()).toContain("Memory is unavailable")
    expect(bodyText()).toContain("Could not reach this instance.")
    // The regression, stated as the assertion.
    expect(bodyText()).not.toContain("Nothing remembered yet")
    expect(document.querySelector('[data-slot="memory-graph-retry"]')).not.toBeNull()
  })

  test("Retry re-asks, and a healed engine replaces the fault with the graph", async () => {
    let first = true
    mount([
      () => {
        if (first) {
          first = false
          throw new TypeError("Failed to fetch")
        }
        return FIXTURE
      },
    ])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("unavailable")
    ;(document.querySelector('[data-slot="memory-graph-retry"]') as HTMLButtonElement).click()
    await settle()
    expect(state()).toBe("ready")
    expect(bodyText()).not.toContain("Memory is unavailable")
  })

  test("a genuinely empty graph still says so — the honest empty is not lost", async () => {
    mount([() => ({ nodes: [], edges: [] })])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("empty")
    expect(bodyText()).toContain("Nothing remembered yet")
  })

  test("🔴 every drawn node fits a NARROW pane — the clipping the fixed plane caused", async () => {
    paneSize = { width: 420, height: 320 }
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const points = drawnPoints()
    expect(points.length).toBe(3)
    for (const p of points) expect(insidePane(p)).toBe(true)
  })

  test("a WIDE pane centres the graph instead of stranding it in the corner", async () => {
    paneSize = { width: 2200, height: 1400 }
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const points = drawnPoints()
    const mid = points.reduce((a, p) => ({ x: a.x + p.x / points.length, y: a.y + p.y / points.length }), { x: 0, y: 0 })
    // The old identity transform kept this whole cluster inside the top-left 1000x700 of the pane.
    expect(mid.x).toBeGreaterThan(paneSize.width * 0.3)
    expect(mid.y).toBeGreaterThan(paneSize.height * 0.3)
  })

  test("resizing the window refits — the marks stay inside the new box", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    expect(drawnPoints().length).toBe(3)
    paneSize = { width: 300, height: 240 }
    for (const cb of resizeCallbacks) cb()
    await settle()
    const points = drawnPoints()
    expect(points.length).toBe(3)
    for (const p of points) expect(insidePane(p)).toBe(true)
  })

  test("showing passages refits to include them", async () => {
    paneSize = { width: 500, height: 400 }
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const before = drawnPoints().length
    const toggle = [...document.querySelectorAll('[data-slot="memory-kind-toggle"]')].find(
      (b) => (b as HTMLElement).dataset.kind === "passage",
    ) as HTMLButtonElement
    toggle.click()
    await settle()
    const after = drawnPoints()
    expect(after.length).toBe(before + 1)
    for (const p of after) expect(insidePane(p)).toBe(true)
  })
})
