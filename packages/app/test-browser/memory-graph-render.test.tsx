import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { MemoryGraphPage } from "@/pages/memory-graph"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { ServerSDKProvider } from "@/context/server-sdk"
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
  status: "active",
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
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
const COMPLETE = { partial: false, total: 7, returned: 7, omitted: 0, reason: "complete" } as const
const FIXTURE: MemoryGraph = { nodes: NODES, edges: EDGES, slice: COMPLETE }
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
  memoryBoardStatus = "ok"
  memoryBoardDetail = undefined
  resizeCallbacks.length = 0
  busListeners = []
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

/**
 * What the diagnosis board reports about the memory engine — the seam a test drives to model an
 * instance whose engine is down. `undefined` is a healthy board with no memory signal at all.
 */
let memoryBoardStatus: "ok" | "problem" | "unknown" | undefined
let memoryBoardDetail: string | undefined

/**
 * THE INSTANCE EVENT STREAM, as something this file can DRIVE.
 *
 * 🔴 The live overlay's whole claim is "you can see it happen", and that is a claim about what the
 * DOM does when an event arrives. A unit test of the fold proves the state transition and nothing
 * about the picture; only a mounted page can answer "did the mark dim". So the SDK's `event.listen`
 * is stubbed to keep its subscribers, and `emitMemory` is the test's hand on the bus.
 *
 * ⚠️ The envelope is the real one — `{ name: directory, details: { type, properties } }` — because
 * the shape is exactly what the page has to decode. A stub that handed over a pre-decoded activity
 * would test the renderer against a contract the server does not use.
 */
let busListeners: ((event: { name: string; details: unknown }) => void)[] = []
const emitMemory = (type: string, properties: unknown) => {
  for (const listener of [...busListeners]) listener({ name: "global", details: { type, properties } })
}

/** The non-graph routes this page's siblings call, each in its own shape. */
const sideAnswer = (url: string): unknown => {
  if (url.includes("api/diagnosis"))
    return {
      overall: memoryBoardStatus === "problem" ? "problem" : "ok",
      headline: "",
      signals:
        memoryBoardStatus === undefined
          ? []
          : [
              {
                id: "memory",
                label: "Memory",
                status: memoryBoardStatus,
                ...(memoryBoardDetail === undefined ? {} : { detail: memoryBoardDetail }),
              },
            ],
    }
  if (url.includes("memory/stats")) return { total: NODES.length, valid: NODES.length }
  // ⚠️ The Remembered list fetches its OWN rows, so a stub that answers `[]` leaves it permanently
  // empty and every assertion about what the list SHOWS passes vacuously. It lists entities and
  // episodes — never passages — which is the same rule the component documents.
  if (url.includes("memory/list")) return NODES.filter((n) => n.kind !== "passage")
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
  // The three things the Memory app asks of the SDK: the stream's status, a subscription, and a
  // start it may call whether or not the shell already did.
  const sdkStub = {
    streamStatus: () => "connected" as const,
    event: {
      start: () => {},
      on: () => () => {},
      listen: (fn: (event: { name: string; details: unknown }) => void) => {
        busListeners.push(fn)
        return () => {
          busListeners = busListeners.filter((entry) => entry !== fn)
        }
      },
    },
  }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({
      agents: agentsCache,
      sync: { data: { path: { directory: "/tmp/p" } } },
      sdk: sdkStub,
    }),
  }
  const syncStub = () => ({ data: { path: { directory: "/tmp/p" } }, session: { data: { info: {} } } })
  // Deliberately echoes the KEY rather than resolving copy — this file asserts which key a row
  // reaches for, not what it says. `plural` echoes the group for the same reason.
  //
  // ⚠️ CORRECTION (2026-09-03): six assertions below were still matching the English SENTENCE, which
  // only ever passed because those two rows were hard-coded literals. `f7427dd8e` keyed them, this
  // stub started echoing the key, and the five tests that guard the empty-versus-fault distinction
  // went red — the exact distinction they exist to hold. They now name the keys, which is what this
  // stub was built to let them do.
  const languageStub = {
    t: (key: string) => key,
    plural: (group: string) => group,
    locale: () => "en",
    setLocale: () => {},
  }

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
                    {/* The real provider, reading the SDK off the global stub — the same path the
                        shell uses. Wrapping the page in a hand-made context value instead would let
                        this file drift from how the app actually resolves its SDK. */}
                    <ServerSDKProvider>
                      <DialogProvider>
                        <MemoryGraphPage />
                      </DialogProvider>
                    </ServerSDKProvider>
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

const drawnNodes = () => [...document.querySelectorAll('[data-slot="memory-graph-node"]')]
const listRowCount = () => document.querySelectorAll('[aria-label="settings.memory.forget.action"]').length
const showList = () => {
  const button = [...document.querySelectorAll('[data-slot="memory-view-switch"]')].find(
    (b) => (b as HTMLElement).dataset.view === "list",
  ) as HTMLButtonElement
  paneShown = false
  button.click()
}
/** Click the mark whose drawn label reads `text` — addressing a node the way a user does. */
const clickMarkByLabel = (text: string) => {
  const label = [...document.querySelectorAll('[data-slot="memory-graph-label"]')].find(
    (el) => el.textContent === text,
  ) as HTMLElement
  const id = label.dataset.nodeId!
  const mark = drawnNodes().find((el) => (el as HTMLElement).dataset.nodeId === id)!
  mark.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}
const clickMark = (kind: string, index: number) => {
  const marks = drawnNodes().filter((el) => (el as HTMLElement).dataset.nodeKind === kind)
  marks[index]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}
const searchCount = () =>
  (document.querySelector('[data-slot="memory-search-count"]') as HTMLElement | null)?.textContent ?? null
const typeSearch = (text: string) => {
  const input = document.querySelector('[data-slot="memory-search"] input') as HTMLInputElement
  input.value = text
  input.dispatchEvent(new Event("input", { bubbles: true }))
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
    expect(bodyText()).toContain("memoryGraph.page.memoryIsUnavailableRightNow")
    expect(bodyText()).toContain("Could not reach this instance.")
    // The regression, stated as the assertion.
    expect(bodyText()).not.toContain("memoryGraph.page.nothingRememberedYetTheGraphFills")
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
    expect(bodyText()).not.toContain("memoryGraph.page.memoryIsUnavailableRightNow")
  })

  test("a genuinely empty graph still says so — the honest empty is not lost", async () => {
    mount([() => ({ nodes: [], edges: [], slice: { ...COMPLETE, total: 0, returned: 0 } })])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("empty")
    expect(bodyText()).toContain("memoryGraph.page.nothingRememberedYetTheGraphFills")
  })

  test("🔴 a BROKEN ENGINE answering 200-with-nothing is not an empty cabinet", async () => {
    // The `/memory/*` read handlers fold a MemoryError into `{nodes:[],edges:[]}` and answer 200, so
    // the transport is perfectly healthy and the graph is perfectly empty. Only the diagnosis board
    // can tell the two apart, and the Remembered tab has been asking it all along while this one said
    // "Nothing remembered yet — the graph fills as you chat" to a user whose engine was dead.
    memoryBoardStatus = "problem"
    memoryBoardDetail = "the graph store failed to open"
    mount([() => ({ nodes: [], edges: [], slice: { ...COMPLETE, total: 0, returned: 0 } })])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("unavailable")
    expect(bodyText()).toContain("memoryGraph.page.memoryIsUnavailableRightNow")
    expect(bodyText()).toContain("the graph store failed to open")
    expect(bodyText()).not.toContain("memoryGraph.page.nothingRememberedYetTheGraphFills")
  })

  test("a board with no DETAIL still says something a person can act on", async () => {
    memoryBoardStatus = "problem"
    mount([() => ({ nodes: [], edges: [], slice: { ...COMPLETE, total: 0, returned: 0 } })])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("unavailable")
    expect(bodyText()).toContain("The memory engine is not running on this instance.")
  })

  test("⚠️ `unknown` is NOT a fault — a lazily-opened engine must not error at every new user", async () => {
    // The engine opens on first demand, so a board read before anything demanded it reports
    // "not opened yet". Treating that as broken would put an error in front of everyone who has
    // simply not chatted yet — the opposite failure, and just as wrong.
    memoryBoardStatus = "unknown"
    mount([() => ({ nodes: [], edges: [], slice: { ...COMPLETE, total: 0, returned: 0 } })])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("empty")
    expect(bodyText()).toContain("memoryGraph.page.nothingRememberedYetTheGraphFills")
  })

  test("a healthy board with memories present never mentions the board at all", async () => {
    memoryBoardStatus = "problem"
    // A problem signal beside a graph that DID return rows: the rows win, because they are the more
    // direct evidence and a banner over a working map is its own kind of lie.
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("ready")
    expect(bodyText()).not.toContain("memoryGraph.page.memoryIsUnavailableRightNow")
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
    const mid = points.reduce((a, p) => ({ x: a.x + p.x / points.length, y: a.y + p.y / points.length }), {
      x: 0,
      y: 0,
    })
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

  test("🔴 a SLICE says so — `n memories` beside a truncated graph reads as everything", async () => {
    mount([
      () => ({
        nodes: NODES,
        edges: EDGES,
        slice: { partial: true, total: 900, returned: 7, omitted: 893, reason: "connected-first" },
      }),
    ])
    await settle()
    showGraph()
    await settle()
    const chip = document.querySelector('[data-slot="memory-graph-slice"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain("893 not shown")
    expect(chip.getAttribute("title")).toContain("Showing 7 of 900")
  })

  test("a COMPLETE graph carries no notice at all", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    expect(document.querySelector('[data-slot="memory-graph-slice"]')).toBeNull()
  })

  test("⚠️ an instance too OLD to report a slice says nothing rather than guessing", async () => {
    // A missing field is not evidence of truncation. Inventing a notice from it would be the same
    // class of lie as the empty cabinet — a confident statement about something nobody reported.
    mount([() => ({ nodes: NODES, edges: EDGES }) as unknown as MemoryGraph])
    await settle()
    showGraph()
    await settle()
    expect(state()).toBe("ready")
    expect(document.querySelector('[data-slot="memory-graph-slice"]')).toBeNull()
  })

  test("a scan-capped answer says PARTIAL without pretending to a number", async () => {
    mount([
      () => ({
        nodes: NODES,
        edges: EDGES,
        slice: { partial: true, total: 7, returned: 7, omitted: 0, reason: "scan-capped" },
      }),
    ])
    await settle()
    showGraph()
    await settle()
    const chip = document.querySelector('[data-slot="memory-graph-slice"]') as HTMLElement
    expect(chip.textContent).toContain("partial view")
    expect(chip.dataset.reason).toBe("scan-capped")
  })

  test("🔴 ONE search box drives BOTH views — a query typed on the list narrows the map", async () => {
    // The hazard this file exists to police: two surfaces of one cabinet answering the same question
    // separately. The roster did it, the health signal did it. A filter would do it silently.
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    typeSearch("dragon")
    await settle()
    // Exactly one memory in the fixture says "Dragon".
    expect(searchCount()).toBe("1 found")
    const dimmed = drawnNodes().filter((el) => el.getAttribute("opacity") === "0.25")
    expect(dimmed.length).toBe(VISIBLE_MEMORIES + 1 - 1)
    // …and it earns a LABEL, or the search answers with a dot nobody can read.
    expect(drawnLabels().some((l) => l.id === "Dragon")).toBe(true)
  })

  test("a search never REMOVES marks — the map would lose what the memory connects to", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const before = drawnMarks().length
    typeSearch("dragon")
    await settle()
    expect(drawnMarks().length).toBe(before)
    expect(edgeEndpoints()).toBe(3)
  })

  test("a query matching nothing says so, and shows zero", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    typeSearch("zzzznotamemory")
    await settle()
    expect(searchCount()).toBe("0 found")
  })

  test("clearing the query restores every mark to full strength", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    typeSearch("dragon")
    await settle()
    typeSearch("")
    await settle()
    expect(document.querySelector('[data-slot="memory-search-count"]')).toBeNull()
    expect(drawnNodes().filter((el) => el.getAttribute("opacity") === "0.25").length).toBe(0)
  })

  test("the LENS switches, and the header says what is in force in one line", async () => {
    // This replaces a `Current / Incl. forgotten` toggle whose field nothing read. The old test
    // passed against it the whole time, because it only ever asserted the button's own label.
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const lens = document.querySelector('[data-slot="memory-lens"]') as HTMLElement
    expect(lens.dataset.lens).toBe("current")
    const hint = () => document.querySelector('[data-slot="memory-lens-hint"]')?.textContent ?? ""
    expect(hint()).toContain("true right now")
    const history = document.querySelector('[data-slot="memory-lens-tab"][data-lens="history"]') as HTMLButtonElement
    history.click()
    await settle()
    expect(lens.dataset.lens).toBe("history")
    expect(hint()).toContain("forgotten")
    // ⚠️ All four questions are reachable, including the one whose answer may be "not measured".
    // ⚠️ The ORDER is the assertion, not just the membership: the three usage lenses sit together
    // between the lifecycle ones and `history`, so a reader scans "what is true / what is unused /
    // what happened" rather than hunting. `useful` and `corrections` joined when the noise endpoints
    // gained a UI — they had no caller before, so the pruning protections had no door.
    expect(
      [...document.querySelectorAll('[data-slot="memory-lens-tab"]')].map((b) => (b as HTMLElement).dataset.lens),
    ).toEqual(["current", "needs-review", "never-used", "useful", "corrections", "history"])
  })

  test("🔴 A WRITE IS CAPTIONED THE MOMENT IT HAPPENS — no reload, no poll", async () => {
    mount([() => FIXTURE])
    await settle()
    expect(document.querySelector('[data-slot="memory-activity-empty"]')).not.toBeNull()
    emitMemory("memory.item.recorded", { id: "e9", scope: "global", kind: "entity", name: "Ada", text: "Ada writes" })
    await settle()
    const entry = document.querySelector('[data-slot="memory-activity-entry"]') as HTMLElement | null
    expect(entry).not.toBeNull()
    expect(entry!.dataset.tone).toBe("write")
    expect(entry!.textContent).toContain("Ada")
  })

  test("🔴 A RECALL HIGHLIGHTS ITS HITS IN RANK ORDER AND DIMS THE REST", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    emitMemory("memory.recalled", {
      fingerprint: "qf_x",
      surface: "auto-recall",
      scopes: ["global"],
      hits: [
        { id: "e1", rank: 1, score: 0.9, scope: "global" },
        { id: "e2", rank: 2, score: 0.5, scope: "global" },
      ],
      considered: 2,
    })
    await settle()
    const ranks = [...document.querySelectorAll('[data-slot="memory-graph-rank"]')].map((el) => ({
      id: (el as HTMLElement).dataset.nodeId,
      rank: (el as HTMLElement).dataset.rank,
    }))
    expect(ranks.map((r) => `${r.id}#${r.rank}`).sort()).toEqual(["e1#1", "e2#2"])
    // ...and every mark the recall did NOT use steps back
    const dimmed = drawnNodes().filter((el) => el.getAttribute("opacity") === "0.25")
    expect(dimmed.length).toBeGreaterThan(0)
    expect(dimmed.some((el) => el.dataset.nodeId === "e1")).toBe(false)
  })

  test("🔴 A RETIREMENT IS VISIBLE, AND THE MARK KEEPS ITS PLACE", async () => {
    // "Superseded claims visibly retire and stay available as history" — which means the node is
    // MARKED, never removed. A viewer that deleted it would throw away the connection that
    // explains why it was retired.
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const before = drawnNodes().length
    emitMemory("memory.forgotten", { id: "e2", mode: "invalidate" })
    await settle()
    expect(drawnNodes().length).toBe(before)
    const retired = [...document.querySelectorAll('[data-slot="memory-graph-retired"]')].map(
      (el) => (el as HTMLElement).dataset.nodeId,
    )
    expect(retired).toContain("e2")
    expect(document.querySelector('[data-slot="memory-activity-entry"]')?.textContent).toContain("Forgot")
  })

  test("search is offered on the LIST too, not only the map", async () => {
    mount([() => FIXTURE])
    await settle()
    // Still on Remembered — the shared header owns the box, so it is there before the map is opened.
    expect(document.querySelector('[data-slot="memory-search"]')).not.toBeNull()
  })

  test("🔴 selecting a mark FOCUSES its neighborhood, and the header says whose", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    clickMark("entity", 0)
    await settle()
    const chip = document.querySelector('[data-slot="memory-focus"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain("memoryGraph.page.connectedTo")
    expect(document.querySelector('[data-slot="memory-focus-clear"]')).not.toBeNull()
  })

  test("focus CLEARS, and the chip goes with it", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    clickMark("entity", 0)
    await settle()
    ;(document.querySelector('[data-slot="memory-focus-clear"]') as HTMLButtonElement).click()
    await settle()
    expect(document.querySelector('[data-slot="memory-focus"]')).toBeNull()
  })

  test("⚠️ focus DIMS the map rather than emptying it — the context is the answer", async () => {
    // Narrowing the drawing to a neighborhood deletes what makes it a neighborhood. The list filters;
    // the map dims. Same asymmetry search has, for the same reason.
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    const before = drawnMarks().length
    clickMark("entity", 0)
    await settle()
    expect(drawnMarks().length).toBe(before)
    expect(drawnNodes().filter((el) => el.getAttribute("opacity") === "0.25").length).toBeGreaterThan(0)
  })

  test("the focus chip is offered on the LIST view too, not only the map", async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    clickMark("entity", 0)
    await settle()
    // Back to Remembered with the focus still set — the chip belongs to the shared header.
    const list = [...document.querySelectorAll('[data-slot="memory-view-switch"]')].find(
      (b) => (b as HTMLElement).dataset.view === "list",
    ) as HTMLButtonElement
    list.click()
    await settle()
    expect(document.querySelector('[data-slot="memory-focus"]')).not.toBeNull()
  })

  test("🔴 focus NARROWS the list to the neighborhood, and names it", async () => {
    // The half the map cannot show: the list is where "what connects to this" is answered as rows.
    mount([() => FIXTURE])
    await settle()
    // ⚠️ Counted on the LIST view. The list lives inside a `<Show>` and is UNMOUNTED while the map is
    // showing, so a count taken after `showGraph()` reads zero for every graph and proves nothing.
    const before = listRowCount()
    expect(before).toBe(VISIBLE_MEMORIES)
    showGraph()
    await settle()
    clickMarkByLabel("Nancy")
    await settle()
    showList()
    await settle()
    expect(listRowCount()).toBeLessThan(before)
    const note = document.querySelector('[data-slot="memory-focus-note"]') as HTMLElement
    expect(note.textContent).toContain("Showing what connects to")
    expect(note.textContent).toContain("Nancy")
  })

  test("clearing focus from the LIST restores every row", async () => {
    mount([() => FIXTURE])
    await settle()
    const before = listRowCount()
    showGraph()
    await settle()
    clickMarkByLabel("Nancy")
    await settle()
    showList()
    await settle()
    const clear = [...document.querySelectorAll("button")].find((b) => b.textContent === "Show everything")!
    clear.click()
    await settle()
    expect(document.querySelector('[data-slot="memory-focus-note"]')).toBeNull()
    expect(listRowCount()).toBe(before)
  })

  test('a focused neighborhood with nothing else in it says THAT, not "nothing remembered"', async () => {
    mount([() => FIXTURE])
    await settle()
    showGraph()
    await settle()
    // The lone episode has no edges at all.
    clickMark("episode", 0)
    await settle()
    showList()
    await settle()
    const text = (document.querySelector('[data-slot="memory-list-empty"]') as HTMLElement | null)?.textContent
    // Either it shows just the episode itself, or it says the neighborhood is otherwise empty — both
    // are honest. What it must never say is that the cabinet is empty.
    expect(document.body.textContent).not.toContain("memoryGraph.page.nothingRememberedYetTheGraphFills")
    if (text) expect(text).toContain("connects to")
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
