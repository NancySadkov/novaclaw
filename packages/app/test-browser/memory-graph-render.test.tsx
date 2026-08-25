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

/**
 * The fixture is INGESTION-SHAPED, because that is the case the projection exists for: a document
 * stored as an entity, passages hanging off it by `part_of`, and an entity whose only path to the
 * document runs through a passage (`Dragon`). Plus a pair of ordinary entities and a lone episode.
 */
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
  node("doc", "entity", "Manual"),
  node("Dragon", "entity", "Dragon"),
  node("p1", "passage", null),
  node("p2", "passage", null),
]
const EDGES: EdgeRow[] = [
  { from: "e1", to: "e2", type: "wrote" },
  { from: "p1", to: "doc", type: "part_of" },
  { from: "p2", to: "doc", type: "part_of" },
  // Dragon's ONLY link. Before the projection, hiding passages deleted it and left Dragon floating.
  { from: "p1", to: "Dragon", type: "mentions" },
]
const FIXTURE: MemoryGraph = { nodes: NODES, edges: EDGES }
/** Memories drawn as themselves when passages are hidden: everything but the two passages. */
const VISIBLE_MEMORIES = 5

// --- DOM seams ----------------------------------------------------------------------------------
let paneSize = { width: 900, height: 600 }
/** Has the user switched to the Graph view? Until then the canvas is `display: none` and has no box. */
let paneShown = false
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
  paneShown = false
  resizeCallbacks.length = 0
  originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    // ONLY the graph canvas reports a size; everything else keeps happy-dom's zeroes, so no other
    // code silently starts depending on a measurement this test invented.
    if (this.dataset?.slot !== "memory-graph-canvas") return rect(0, 0)
    // 🔴 A HIDDEN PANE HAS NO BOX. The page opens on Remembered, so the canvas carries Tailwind's
    // `hidden` (`display: none`) at mount — and an element with no box measures 0x0 AND is never
    // reported by a `ResizeObserver` armed on it. The first draft of this stub returned the pane size
    // unconditionally, which is why every camera and label assertion here passed while the shipped app
    // drew at `translate(0 0) scale(1)` with zero labels. Instrumented live 2026-08-25: the observer
    // logged its `observe(w=0)` and never fired once.
    // ⚠️ `paneShown`, not the element's class. Solid applies `classList` in an EFFECT, which runs
    // AFTER the `ref` callback — so at the moment `attachCanvas` measures, the class is not on the
    // element yet and a class-based stub reports a full-size box. That draft still passed with the
    // fix removed. The browser has no such window: the style is in effect before anything is laid
    // out. What has to be modelled is the PAGE state — the pane has no box until the user opens it.
    return paneShown && !this.classList.contains("hidden") ? rect(paneSize.width, paneSize.height) : rect(0, 0)
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
  paneShown = true
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

/** Every drawn mark with its kind and its SCREEN centre. */
function drawnMarks(): { kind: string; x: number; y: number }[] {
  const group = document.querySelector('[data-slot="memory-graph-canvas"] svg > g') as SVGGElement | null
  const parsed = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(group?.getAttribute("transform") ?? "")
  if (!group || !parsed) return []
  const [tx, ty, scale] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
  return [...document.querySelectorAll('[data-slot="memory-graph-node"]')].map((el) => {
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(el.getAttribute("transform")!)!
    return {
      kind: (el as HTMLElement).dataset.nodeKind ?? "",
      x: Number(m[1]) * scale + tx,
      y: Number(m[2]) * scale + ty,
    }
  })
}

/**
 * Every drawn label as a screen-space BOX, using the same character metrics `labels.ts` places with.
 *
 * ⚠️ happy-dom does no text layout, so a real measured width is not available here — this is the
 * placement contract restated, which is what the overlap assertion is actually about. The metrics
 * being an estimate is the module's own design (`charWidth`), not a shortcut taken by the test.
 */
function drawnLabels(): { id: string; x: number; y: number; w: number; h: number }[] {
  return [...document.querySelectorAll('[data-slot="memory-graph-label"]')].map((el) => {
    const text = el.textContent ?? ""
    return {
      id: (el as HTMLElement).dataset.nodeId ?? "",
      x: Number(el.getAttribute("x")),
      y: Number(el.getAttribute("y")) - 4 - 13 / 2,
      w: text.length * 5.6,
      h: 13,
    }
  })
}

const boxesOverlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The `data-node-kind` of every drawn mark — `entity` / `episode` / `passage` / `hub`. */
const markKinds = () =>
  [...document.querySelectorAll('[data-slot="memory-graph-node"]')].map((el) => (el as HTMLElement).dataset.nodeKind)
const hubCount = () => markKinds().filter((k) => k === "hub").length
/** Which marks the drawn edges actually join, as `from->to` over the plane positions. */
const edgeEndpoints = () => [...document.querySelectorAll('[data-slot="memory-graph-canvas"] svg line')].length

describe("MemoryGraphPage renders", () => {
  test("the instrument works at all — the graph mounts and draws its visible marks", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    // Guard on the instrument: if this is wrong every assertion below is vacuous.
    expect(state()).toBe("ready")
    // Five memories drawn as themselves, plus ONE hub standing for the two hidden passages.
    expect(drawnPoints().length).toBe(VISIBLE_MEMORIES + 1)
    expect(hubCount()).toBe(1)
  })

  test("🔴 an entity reachable only THROUGH a passage keeps its links when passages are hidden", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    // Dragon's one stored edge is `p1 -mentions-> Dragon`. Before the projection, hiding passages
    // dropped that edge and Dragon sat unconnected beside a document with nothing attached to it.
    // Three lines now: e1-e2, hub-doc (×2 merged), hub-Dragon.
    expect(edgeEndpoints()).toBe(3)
    expect(document.body.textContent).toContain("2 passages")
  })

  test("the hub explains itself, and reveals the kind it stands for", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const hub = [...document.querySelectorAll('[data-slot="memory-graph-node"]')].find(
      (el) => (el as HTMLElement).dataset.nodeKind === "hub",
    ) as SVGGElement
    hub.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle()
    const detail = document.querySelector('[data-slot="memory-graph-detail"]')!
    expect(detail.textContent).toContain("2 passages, drawn as one mark.")
    // The merged `part_of` edge says how many stored links it stands for.
    expect(detail.textContent).toContain("×2")
    ;(document.querySelector('[data-slot="memory-hub-reveal"]') as HTMLButtonElement).click()
    await settle()
    expect(hubCount()).toBe(0)
    expect(markKinds().filter((k) => k === "passage").length).toBe(2)
  })

  test("NO entity-to-entity edge is invented to bridge a hidden passage", async () => {
    // The cheap repair would draw `doc -> Dragon` because a passage joined them. Every drawn line
    // must have a stored edge or a hub behind it, so a run with passages VISIBLE must produce the
    // same number of lines as there are stored edges.
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const toggle = [...document.querySelectorAll('[data-slot="memory-kind-toggle"]')].find(
      (b) => (b as HTMLElement).dataset.kind === "passage",
    ) as HTMLButtonElement
    toggle.click()
    await settle()
    expect(hubCount()).toBe(0)
    expect(edgeEndpoints()).toBe(EDGES.length)
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
    expect(points.length).toBe(VISIBLE_MEMORIES + 1)
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
    expect(drawnPoints().length).toBe(VISIBLE_MEMORIES + 1)
    paneSize = { width: 300, height: 240 }
    // BOTH signals, because the page must not depend on either alone — a ResizeObserver armed on this
    // canvas was measured delivering nothing at all in the web build (see `attachCanvas`).
    for (const cb of resizeCallbacks) cb()
    window.dispatchEvent(new Event("resize"))
    await settle()
    const points = drawnPoints()
    expect(points.length).toBe(VISIBLE_MEMORIES + 1)
    for (const p of points) expect(insidePane(p)).toBe(true)
  })

  test("🔴 labels are CULLED under crowding, never piled on top of each other", async () => {
    // A tiny pane projects every mark into a small box, so their labels want the same pixels. The old
    // rule drew all of them (under forty marks) or none (over forty); neither is readable.
    paneSize = { width: 240, height: 200 }
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const labels = drawnLabels()
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.length).toBeLessThan(VISIBLE_MEMORIES + 1)
    // The property, stated directly: no two drawn labels share pixels.
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(boxesOverlap(labels[i]!, labels[j]!)).toBe(false)
      }
    }
  })

  test("the SELECTED mark keeps its label however crowded the pane is", async () => {
    paneSize = { width: 240, height: 200 }
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const mark = [...document.querySelectorAll('[data-slot="memory-graph-node"]')].find(
      (el) => (el as HTMLElement).dataset.nodeKind === "episode",
    ) as SVGGElement
    mark.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await settle()
    const selectedID = document.querySelector('[data-slot="memory-graph-detail"]') ? true : false
    expect(selectedID).toBe(true)
    // The episode is `ep1`; whatever else was culled, the thing the user clicked is named.
    expect(drawnLabels().some((l) => l.id === "ep1")).toBe(true)
  })

  test("every drawn label lies inside the viewport", async () => {
    paneSize = { width: 420, height: 320 }
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    for (const label of drawnLabels()) {
      expect(label.x).toBeGreaterThanOrEqual(0)
      expect(label.y).toBeGreaterThanOrEqual(0)
      expect(label.x + label.w).toBeLessThanOrEqual(paneSize.width)
      expect(label.y + label.h).toBeLessThanOrEqual(paneSize.height)
    }
  })

  test("🔴 an unlinked memory sits OUTSIDE the connected marks, not among them", async () => {
    // `ep1` is the episode with no edges. Gravity used to leave it inside the cluster, where a memory
    // with no relationships reads as one of the related ones.
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const marks = drawnMarks()
    const orphan = marks.find((m) => m.kind === "episode")!
    const core = marks.filter((m) => m.kind !== "episode")
    const box = {
      minX: Math.min(...core.map((m) => m.x)),
      maxX: Math.max(...core.map((m) => m.x)),
      minY: Math.min(...core.map((m) => m.y)),
      maxY: Math.max(...core.map((m) => m.y)),
    }
    expect(orphan.x < box.minX || orphan.x > box.maxX || orphan.y < box.minY || orphan.y > box.maxY).toBe(true)
  })

  test("showing passages refits to include them", async () => {
    paneSize = { width: 500, height: 400 }
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    expect(drawnPoints().length).toBe(VISIBLE_MEMORIES + 1)
    const toggle = [...document.querySelectorAll('[data-slot="memory-kind-toggle"]')].find(
      (b) => (b as HTMLElement).dataset.kind === "passage",
    ) as HTMLButtonElement
    toggle.click()
    await settle()
    // The hub dissolves back into the two passages it stood for: 5 + 1 hub -> 7 memories.
    const after = drawnPoints()
    expect(after.length).toBe(NODES.length)
    expect(hubCount()).toBe(0)
    for (const p of after) expect(insidePane(p)).toBe(true)
  })
})
