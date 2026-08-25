import { A, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { MemoryRemembered } from "@/components/memory-remembered"
import { SettingsMemoryV2 } from "@/components/settings-v2/memory"
import { Icon } from "@novaclaw/ui/v2/icon"
import { useGlobal } from "@/context/global"
import { useServer, ServerConnection } from "@/context/server"
import { memoryGraph, type MemoryGraph, type MemoryRow } from "@/utils/memory-api"
import { ownerFromKey, ownersFor, scopeOwnerName, type MemoryOwner } from "@/apps/memory-owner"
import { type AgentLike } from "@/apps/contacts"
import { layoutGraph, type Vec } from "./memory-graph/layout"
import {
  centerOn,
  contentBounds,
  fitView,
  IDENTITY,
  isVisible,
  MAX_SCALE,
  MIN_SCALE,
  project,
  type View,
} from "./memory-graph/camera"
import { nearestNeighborDistance, placeLabels, Priority, type LabelCandidate } from "./memory-graph/labels"
import { graphFault, type GraphFault } from "./memory-graph/fault"
import { hubLabel, isHub, projectGraph, type ProjectedNode } from "./memory-graph/project"

// The Memory graph viewer (notes/kb-graph-plan.md §5 — the advanced, node-link surface for
// path-tracing) — renders the graph memory as an interactive node-link diagram over /memory/graph +
// /memory/neighbors. ⚠️ It is NOT gated: this header claimed "a Developer-mode page (the home tile is
// minLevel-gated)" until 2026-08-19, but the owner moved the tile to Normal on 2026-08-12 — "what
// NovaClaw remembers about you is not an expert topic" (`apps/builtins.tsx`). The tile carries no
// `minLevel`, so `app-routes.test.ts` asks nothing of this page, correctly. Dependency-free
// (custom deterministic layout + inline SVG); local-first/airgap-friendly and no npm graph lib. Strings
// stay untranslated on purpose — a Developer diagnostic surface, like Registry/Debug.

// The layout PLANE — a fixed coordinate space, deliberately NOT the viewport. See `memory-graph/camera.ts`:
// the plane is cached per instance so a re-open never reshuffles, and the camera is what fits it to the
// window. These two used to be the same numbers, which is why a small window clipped nodes.
const PLANE_W = 1000
const PLANE_H = 700
const GRAPH_LIMIT = 600

// Node colour by scope. THREE now, since memory belongs to colleagues (AGENTS.md — the structural
// metaphor): the household's shared facts, one colleague's own cabinet, and one chat.
const SCOPE_GLOBAL = "#8b5cf6" // violet — shared with every colleague
const SCOPE_AGENT = "#e0a33e" // gold — this colleague's own
const SCOPE_SESSION = "#22d3ee" // cyan — this chat only
const scopeColor = (scope: string) =>
  scope === "global" ? SCOPE_GLOBAL : scope.startsWith("agent:") ? SCOPE_AGENT : SCOPE_SESSION
/** ⚠️ Says WHO CAN READ IT, never the raw key. `agent:talent-scout` is a store key; "Talent Scout's
 *  own" is the fact the user needs, and the difference is whether the badge can be acted on. */
const scopeLabel = (scope: string, owners: readonly MemoryOwner[]) => {
  if (scope === "global") return "Shared with everyone"
  if (scope.startsWith("session:")) return "One chat"
  const name = scopeOwnerName(scope, owners)
  return name ? `${name}'s own` : scope
}

/**
 * What to write beside a node.
 *
 * An ENTITY has a name, and a name is already a label. An episode or a passage has only prose, and
 * prose clipped at 28 characters is not a label — it is the first few words of something, which is
 * what made every node read as a fragment. Those say what they ARE; their text is in the detail
 * card one click away, where there is room for it.
 */
const nodeLabel = (node: { kind?: string; name?: string | null; text?: string | null }) => {
  const name = node.name?.trim()
  if (name) return truncate(name, 28)
  if (node.kind === "episode") return "Episode"
  if (node.kind === "passage") return "Passage"
  return truncate(node.text ?? "", 24)
}

/** ⚠️ A shape encoding nobody can decode is a different mystery, not a fix. */
const KIND_LEGEND = [
  { kind: "entity", label: "Entity — a thing NovaClaw knows about" },
  { kind: "episode", label: "Episode — something that happened" },
  { kind: "passage", label: "Passage — source text it came from" },
] as const

const truncate = (text: string, n = 40) => (text.length > n ? text.slice(0, n - 1) + "…" : text)

/** The hub's mark — a hexagon at radius 7, the one shape none of the three memory kinds uses. */
const HEX = [0, 1, 2, 3, 4, 5]
  .map((i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2
    return `${(Math.cos(angle) * 7).toFixed(2)},${(Math.sin(angle) * 7).toFixed(2)}`
  })
  .join(" ")

/**
 * How thick a merged edge is drawn.
 *
 * LOGARITHMIC and capped. A hub's `part_of` edge can stand for 202 stored links while its neighbour
 * stands for one; drawn proportionally that is a black band beside a hair, and the map would be about
 * one document's chunk count rather than about what NovaClaw knows. `log10` puts 1, 10 and 100 a
 * constant distance apart, which is the honest reading of "an order of magnitude more".
 */
export const edgeWidth = (count: number, active: boolean): number => {
  const base = active ? 1.5 : 0.75
  return base * (1 + Math.min(1.5, Math.log10(Math.max(1, count))))
}

/**
 * How far a mark must be from its nearest neighbour, in SCREEN px, to count as standing on its own.
 *
 * Roughly one label's width. Below that its text is competing with somebody's; above it, the label is
 * free — it cannot be the thing crowding another out, so drawing it costs nothing and the orphan band
 * (`layout.ts`) becomes readable without spending the crowded centre's budget.
 */
const ISOLATED_PX = 110

/**
 * What one graph fetch produced — a TAGGED result, never a bare `MemoryGraph`.
 *
 * 🔴 The failure is carried in the value rather than thrown into Solid's resource error path on
 * purpose. This page already learned that lesson once: an uncaught rejection here reached the root
 * `ErrorBoundary` and replaced the whole UI with the error page (see the roster comment below). The
 * rule the vision states is that the UI degrades and recovers — it never crashes to a dead end — so
 * the fault has to be a state this screen can RENDER, which means it has to survive as data.
 */
type GraphLoad =
  | { readonly status: "ready"; readonly graph: MemoryGraph }
  | { readonly status: "unavailable"; readonly fault: GraphFault }

// Cross-open stability: cache the laid-out positions per instance so a re-open never reshuffles, and
// growth only settles the new nodes (existing ones seed from the cache).
const cacheKey = (serverKey: string) => `nc-memgraph-pos:${serverKey}`
function readCache(serverKey: string): Record<string, Vec> {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(serverKey)) || "{}") as Record<string, Vec>
  } catch {
    return {}
  }
}
function writeCache(serverKey: string, pos: Record<string, Vec>) {
  try {
    localStorage.setItem(cacheKey(serverKey), JSON.stringify(pos))
  } catch {
    /* quota / private mode — layout still works, just not cached */
  }
}

export function MemoryGraphPage() {
  const global = useGlobal()
  const server = useServer()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const directory = () => {
    const path = ctx()?.sync.data.path
    return path?.home || path?.directory || ""
  }
  const [tick, setTick] = createSignal(0)

  // WHO works here — the server context's ONE shared roster, so the two surfaces can never disagree
  // about who exists.
  //
  // ⚠️ It used to be a SECOND `listAgents` resource, and the comment above it claimed the same thing
  // this one does — "the same loader the Contacts roster uses". Same loader, different call: two
  // fetches, two answers, and a rejection with no `.catch` that reached the root ErrorBoundary and
  // replaced the whole UI with the error page.
  const agents = () => ctx()?.agents.list()
  const owners = createMemo(() => ownersFor(agents() ?? ([] as AgentLike[]), "Shared with everyone"))
  // WHOSE memory, taken from the URL first.
  //
  // 🔴 This is the door a colleague's own config opens (`agent-config-dialog.tsx` → `ownerRoute`).
  // Under the roster, "what does this colleague remember" is a question you ask ABOUT A COLLEAGUE,
  // so it must be reachable from that colleague — not only by opening a global app and hunting for
  // the name in a picker, which is the same shape as the chat list the roster replaced.
  const [params, setParams] = useSearchParams<{ owner?: string }>()
  const [ownerKey, setOwnerKey] = createSignal<string | undefined>()
  const owner = createMemo(() => ownerFromKey(owners(), ownerKey() ?? params.owner))

  const [graph] = createResource(
    () => {
      const cn = conn()
      const scopes = owner()?.scopes
      // No owner resolved yet = the roster has not loaded. Querying now would draw the WHOLE graph
      // for a moment and then swap it for one colleague's — a flash of everyone's memories in a view
      // whose entire promise is that they are separate.
      return cn && scopes ? { cn, dir: directory(), scopes, t: tick() } : undefined
    },
    ({ cn, dir, scopes }): Promise<GraphLoad> =>
      memoryGraph(cn.http, { directory: dir, limit: GRAPH_LIMIT, scopes })
        .then((graph) => ({ status: "ready", graph }) as const)
        .catch((error) => ({ status: "unavailable", fault: graphFault(error) }) as const),
  )

  /**
   * The graph, or `undefined` while it is loading or unavailable.
   *
   * ⚠️ `graph.latest`, not `graph()`: a refetch (Refresh, or an owner switch) must keep the marks on
   * screen instead of blanking the canvas back to the loading text and then re-fitting the camera.
   */
  const load = () => graph.latest
  const loaded = createMemo(() => {
    const current = load()
    return current?.status === "ready" ? current.graph : undefined
  })
  const fault = (): GraphFault | undefined => {
    const current = load()
    return current?.status === "unavailable" ? current.fault : undefined
  }

  /**
   * Which kinds to draw. Passages are OFF by default: measured on a real instance, they were 202 of
   * 281 nodes, and the graph reads as a wall of identical marks with them on. The chip shows its off
   * state and the header counts what is hidden, so this is a default rather than a concealment.
   */
  const [visibleKinds, setVisibleKinds] = createSignal<ReadonlySet<string>>(new Set(["entity", "episode"]))
  const kindVisible = (kind?: string) => visibleKinds().has(kind ?? "entity")
  const toggleKind = (kind: string) =>
    setVisibleKinds((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  /**
   * WHAT IS ON THE CANVAS — the visible projection, not the raw graph.
   *
   * Hiding a kind used to be a render-time skip: the hidden nodes still pulled on the layout, and any
   * edge touching one was simply not drawn. `memory-graph/project.ts` has the full reasoning; the
   * short version is that an ingested document's extracted entities reach it ONLY through passages,
   * so the default view kept the marks and deleted the structure.
   */
  const projected = createMemo(() =>
    projectGraph(loaded()?.nodes ?? [], loaded()?.edges ?? [], (kind) => kindVisible(kind)),
  )
  const hiddenCount = () => projected().hiddenCount

  // Deterministic layout of the PROJECTION, seeded from the per-instance cache (stable across opens);
  // positions are written back so a later open reuses them and only new nodes settle. Hub ids are
  // derived from their anchor and kind, so they are cacheable too — toggling a kind off and on again
  // returns the same picture rather than reshuffling.
  const positions = createMemo<Record<string, Vec>>(() => {
    const graph = projected()
    if (graph.nodes.length === 0) return {}
    const key = conn() ? ServerConnection.key(conn()!) : "default"
    const cached = readCache(key)
    const ids = graph.nodes.map((n) => n.id)
    const allCached = ids.every((id) => cached[id])
    const pos = layoutGraph(ids, graph.edges, {
      width: PLANE_W,
      height: PLANE_H,
      seed: cached,
      // If nothing is new, don't re-simulate — reuse the cached layout verbatim (perfect stability).
      iterations: allCached ? 0 : 300,
    })
    writeCache(key, pos)
    return pos
  })

  const nodeById = createMemo(() => {
    const map = new Map<string, ProjectedNode>()
    for (const n of projected().nodes) map.set(n.id, n)
    return map
  })
  /** The stored row behind a mark, when there is one — a hub has none. */
  const rowOf = (id: string): MemoryRow | undefined => {
    const node = nodeById().get(id)
    return node && !isHub(node) ? node.row : undefined
  }

  const [selected, setSelected] = createSignal<string | undefined>()
  // The set of node ids adjacent to the selected node (both directions) — used to highlight.
  const neighborIds = createMemo(() => {
    const sel = selected()
    const set = new Set<string>()
    if (!sel) return set
    for (const e of projected().edges) {
      if (e.from === sel) set.add(e.to)
      if (e.to === sel) set.add(e.from)
    }
    return set
  })
  const selectedNode = createMemo(() => (selected() ? nodeById().get(selected()!) : undefined))
  /** Narrowing helpers for the detail panel — a mark is either a stored memory or a hub. */
  const isHubNode = (node: ProjectedNode) => (isHub(node) ? node : undefined)
  const selectedScope = () => {
    const node = selectedNode()
    if (!node) return undefined
    return isHub(node) ? node.scope : node.row.scope
  }
  /** What to call a mark in prose — a memory's text, or the hub's count. */
  const markLabel = (id: string) => {
    const node = nodeById().get(id)
    if (!node) return id
    return isHub(node) ? hubLabel(node) : node.row.text
  }
  /** What goes on the CANVAS beside a mark — the short form, not the prose. */
  const markText = (node: ProjectedNode) => (isHub(node) ? hubLabel(node) : nodeLabel(node.row))
  const selectedEdges = createMemo(() => {
    const sel = selected()
    if (!sel) return []
    return projected()
      .edges.filter((e) => e.from === sel || e.to === sel)
      .map((e) => ({
        type: e.type,
        count: e.count,
        other: e.from === sel ? e.to : e.from,
        dir: e.from === sel ? "→" : "←",
      }))
  })

  // --- the camera: pan / zoom, and the fit that makes the plane meet a real window ---
  //
  // 🔴 The viewport is MEASURED, never assumed. The canvas used to draw a 1000x700 plane at scale 1
  // into whatever box the flex layout handed it: narrower than 1000 and the right-hand memories were
  // simply gone, wider and the whole graph huddled in the top-left with the rest of the pane empty.
  // Both are the same bug — a drawing surface that never asked how big it was.
  const [view, setView] = createSignal<View>(IDENTITY)
  const [viewport, setViewport] = createSignal({ width: 0, height: 0 })
  let dragging = false
  let last = { x: 0, y: 0 }
  let svgEl: SVGSVGElement | undefined

  /** The plane points the camera has to cover — every mark in the projection, hubs included. */
  const visiblePoints = createMemo<Vec[]>(() => {
    const pos = positions()
    const out: Vec[] = []
    for (const node of projected().nodes) {
      const p = pos[node.id]
      if (p) out.push(p)
    }
    return out
  })
  const fitted = () => fitView(contentBounds(visiblePoints()), viewport())

  const measure = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    // happy-dom and a hidden pane both report 0x0; keeping the last real size beats fitting to nothing.
    if (rect.width > 0 && rect.height > 0) setViewport({ width: rect.width, height: rect.height })
  }
  const attachCanvas = (el: HTMLDivElement) => {
    measure(el)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measure(el))
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  }

  /**
   * Refit when the CONTENT or the WINDOW changes — and only then.
   *
   * The user's own zoom and pan are theirs to keep: this effect tracks the content bounds and the
   * measured viewport, so dragging the graph around does not retrigger it, while resizing the window,
   * toggling a kind, switching owner or loading a new slice does. That is exactly the rule the ledger
   * asks for, expressed as a dependency list rather than as a flag somebody has to remember to clear.
   */
  createEffect(
    on(
      () => {
        const b = contentBounds(visiblePoints())
        const v = viewport()
        return b && v.width > 0 ? `${b.minX},${b.minY},${b.maxX},${b.maxY}|${v.width}x${v.height}` : undefined
      },
      (key) => {
        if (key === undefined) return
        setView(fitted())
      },
    ),
  )

  /**
   * A selection the camera cannot see is a detail panel describing an invisible mark. Clicking a link
   * in that panel is a request to SEE the other end, so pan to it — without changing the zoom the user
   * chose (`centerOn`).
   */
  createEffect(
    on(selected, (id) => {
      if (!id) return
      const p = positions()[id]
      const port = viewport()
      if (!p || port.width === 0) return
      if (!isVisible(p, view(), port)) setView((v) => centerOn(p, v, port))
    }),
  )

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = svgEl?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const v = view()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor))
    // Keep the point under the cursor fixed while zooming.
    const k = scale / v.scale
    setView({ tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k, scale })
  }
  const onPointerDown = (e: PointerEvent) => {
    dragging = true
    last = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    const v = view()
    setView({ tx: v.tx + (e.clientX - last.x), ty: v.ty + (e.clientY - last.y), scale: v.scale })
    last = { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = () => {
    dragging = false
  }
  // Reset FITS; it does not return to the identity transform. "Reset view" means "show me everything
  // again", and an identity transform on a plane larger than the window shows a corner of it.
  const resetView = () => setView(fitted())

  /**
   * LIST first. "What do you know about me" is answered in sentences; the graph answers "how does
   * it connect", which is the second question. Opening on the graph led with the harder view.
   */
  const [appView, setAppView] = createSignal<"list" | "graph" | "settings">("list")

  const count = () => loaded()?.nodes.length ?? 0

  /**
   * WHICH LABELS FIT — screen-space, priority-ordered, overlap-culled (`memory-graph/labels.ts`).
   *
   * 🔴 What this replaces: `visibleCount() <= 40`. Under forty marks every one got a label and they
   * piled on top of each other; over forty nobody did. Measured 2026-08-12, a document ingest left
   * ONE visible node on the canvas and it was drawn unlabelled, because the threshold counted the 303
   * TOTAL rows rather than what was on screen — a single anonymous dot, produced precisely BECAUSE the
   * filter was doing its job. A count was never the right question; whether the text FITS is.
   */
  const labelled = createMemo<ReadonlySet<string>>(() => {
    const nodes = projected().nodes
    const port = viewport()
    if (nodes.length === 0 || port.width === 0) return new Set<string>()
    const pos = positions()
    const v = view()
    const screen = nodes.map((node) => {
      const p = pos[node.id]
      return p ? project(p, v) : { x: Number.NaN, y: Number.NaN }
    })
    const sel = selected()
    const near = neighborIds()
    const candidates: LabelCandidate[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      const at = screen[i]!
      if (Number.isNaN(at.x)) continue
      const priority = isHub(node)
        ? Priority.Hub
        : node.id === sel
          ? Priority.Selected
          : near.has(node.id)
            ? Priority.Neighbor
            : // Spatially alone: its label cannot be the thing crowding anyone out, so it is free.
              nearestNeighborDistance(screen, i) > ISOLATED_PX
              ? Priority.Isolated
              : Priority.Ordinary
      // ⚠️ Selected outranks Hub even when the selection IS a hub — clicking a mark must always be
      // able to read its own label back.
      candidates.push({
        id: node.id,
        text: markText(node),
        x: at.x,
        y: at.y,
        priority: node.id === sel ? Priority.Selected : priority,
      })
    }
    return placeLabels(candidates, { viewport: port })
  })

  /**
   * Which of the four things is true — the single value the canvas branches on, and the one a test
   * can read off the DOM (`data-state`).
   *
   * ⚠️ `loading` outranks `unavailable`: a Retry that is in flight must not keep showing the reason
   * it is retrying, or the button reads as if it did nothing.
   */
  const graphState = (): "loading" | "unavailable" | "empty" | "ready" => {
    if (graph.loading && count() === 0) return "loading"
    if (fault()) return "unavailable"
    return count() > 0 ? "ready" : "empty"
  }

  return (
    <div class="flex h-full w-full flex-col bg-v2-background-bg-base text-v2-text-text-base">
      <header class="flex items-center gap-3 border-b border-v2-border-border-muted px-4 py-2.5">
        <A href="/" class="flex items-center gap-1.5 text-sm opacity-70 hover:opacity-100">
          <Icon name="arrow-left" size="large" />
          Home
        </A>
        <div class="flex items-center gap-2">
          <Icon name="branch" size="large" />
          <h1 class="text-sm font-medium">Memory</h1>
        </div>
        {/* WHOSE memory. The app used to show one undifferentiated pile, which was the only honest
            rendering while there was one pile; now every memory belongs to a colleague, to one chat
            or to the household, and a view that hid that would be the last place still claiming the
            old model. Nova is included like anyone else — it is not a super-user of its colleagues'
            cabinets, it just has one of its own. */}
        <label class="flex items-center gap-1.5 text-[11px] opacity-80" data-slot="memory-owner-picker">
          <span class="opacity-70">Whose</span>
          <select
            class="rounded bg-v2-background-bg-layer-01 px-1.5 py-1 text-[11px]"
            value={owner()?.key ?? ""}
            onChange={(event) => {
              setOwnerKey(event.currentTarget.value)
              // The URL follows the picker, so this view is linkable and the back button means
              // something. `replace` — switching whose cabinet you are reading is not a navigation
              // step a user wants to walk back through one colleague at a time.
              setParams({ owner: event.currentTarget.value }, { replace: true })
            }}
          >
            <For each={owners()}>
              {(entry) => (
                // ⚠️ `selected` per option, not only `value` on the select. The options arrive with
                // the roster — AFTER the element is created — and a browser keeps `selectedIndex`
                // at 0 when children appear later, so the control read "Nova" while the page drew
                // somebody else's memories. Measured 2026-08-21 by following the link this slice
                // adds: URL `owner=agent:lysander`, graph showing Lysander's three memories, picker
                // saying Nova. A control that names the wrong owner is worse than no control.
                <option value={entry.key} selected={entry.key === owner()?.key}>
                  {entry.avatar ? `${entry.avatar} ${entry.label}` : entry.label}
                </option>
              )}
            </For>
          </select>
        </label>
        <div class="flex items-center gap-0.5 rounded-md bg-v2-background-bg-layer-01 p-0.5 text-[11px]">
          <For
            each={
              [
                { id: "list", label: "Remembered" },
                { id: "graph", label: "Graph" },
                // Everything that used to be Settings → Memory. The app is where a person asks
                // "what do you know about me", so it is where they should be able to answer
                // "and stop knowing it" — including the on/off switch and the import/export.
                { id: "settings", label: "Settings" },
              ] as const
            }
          >
            {(entry) => (
              <button
                type="button"
                data-slot="memory-view-switch"
                data-view={entry.id}
                aria-pressed={appView() === entry.id}
                onClick={() => setAppView(entry.id)}
                class="rounded px-2 py-1"
                classList={{
                  "bg-v2-background-bg-layer-03 text-v2-text-text-base": appView() === entry.id,
                  "opacity-60 hover:opacity-100": appView() !== entry.id,
                }}
              >
                {entry.label}
              </button>
            )}
          </For>
        </div>

        {/* The legend belongs to the GRAPH, so it appears with it — a legend for marks that are not
            on screen is noise. */}
        <Show when={appView() === "graph"}>
        <div class="flex items-center gap-3 text-[11px] opacity-70" data-slot="memory-kind-legend">
          <For each={KIND_LEGEND}>
            {(entry) => (
              <button
                type="button"
                data-slot="memory-kind-toggle"
                data-kind={entry.kind}
                data-on={kindVisible(entry.kind) ? "" : undefined}
                aria-pressed={kindVisible(entry.kind)}
                onClick={() => toggleKind(entry.kind)}
                title={entry.label}
                class="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-v2-background-bg-layer-02"
                classList={{ "opacity-35": !kindVisible(entry.kind) }}
              >
                <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
                  <Show
                    when={entry.kind === "entity"}
                    fallback={
                      <Show
                        when={entry.kind === "episode"}
                        fallback={
                          <rect x={-4} y={-4} width={8} height={8} rx={1} fill="none" stroke="currentColor" stroke-width={1.5} />
                        }
                      >
                        <rect x={-4} y={-4} width={8} height={8} transform="rotate(45)" fill="currentColor" />
                      </Show>
                    }
                  >
                    <circle r={4.5} fill="currentColor" />
                  </Show>
                </svg>
                <span>{entry.label.split(" — ")[0]}</span>
              </button>
            )}
          </For>
        </div>
        </Show>
        <Show when={appView() === "graph" && hiddenCount() > 0}>
          <span class="text-[11px] opacity-50" data-slot="memory-hidden-count">
            {hiddenCount()} hidden
          </span>
        </Show>
        <span class="text-xs opacity-50">
          {count()} {count() === 1 ? "memory" : "memories"} · {loaded()?.edges.length ?? 0} links
        </span>
        <div class="ml-auto flex items-center gap-3 text-xs">
          {/* Three scopes, three marks. The legend used to name two because there WERE two; leaving
              it at two after the roster landed would be the one place still describing the old model
              — and a colour with no legend entry is a mystery, not a hint. */}
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_GLOBAL }} /> Shared
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_AGENT }} /> Its own
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_SESSION }} /> One chat
          </span>
          <button class="opacity-70 hover:opacity-100" title="Reset view" onClick={resetView}>
            <Icon name="expand" size="large" />
          </button>
          <button class="opacity-70 hover:opacity-100" title="Refresh" onClick={() => setTick((t) => t + 1)}>
            <Icon name="reset" size="large" />
          </button>
        </div>
      </header>

      {/* The Remembered list, in the app where a person actually asks "what do you know about me".
          It owns its own fetch, so switching views does not depend on the graph having loaded. */}
      <Show when={appView() === "list"}>
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* The list obeys the same picker as the graph: two views of ONE colleague's memory,
              never one scoped and one not. */}
          <MemoryRemembered scopes={owner()?.scopes} />
        </div>
      </Show>

      {/* The retired Settings → Memory tab, hosted here verbatim (`embedded` drops its tab header).
          Same component the dialog used, so consent, embedding, the judge model, export/import and
          document ingest all keep working exactly as they did — this MOVED the surface, it did not
          reimplement it. */}
      <Show when={appView() === "settings"}>
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-slot="memory-app-settings">
          <SettingsMemoryV2 embedded />
        </div>
      </Show>

      {/* ⚠️ `ref={attachCanvas}` on the CANVAS wrapper, not on the svg: the svg is inside the `Show`
          and is torn down and rebuilt as the state changes, so an observer bound to it would be
          discarded on every fault and re-created with a stale size. The wrapper is always mounted. */}
      <div
        ref={attachCanvas}
        class="relative flex min-h-0 flex-1"
        classList={{ hidden: appView() !== "graph" }}
        data-slot="memory-graph-canvas"
        data-state={graphState()}
      >
        <Show
          when={count() > 0}
          fallback={
            /* FOUR states, not two. "Loading", "unavailable" and "empty" used to collapse into one
               sentence — and because every rejection was caught as an empty graph, the sentence a
               broken engine produced was "Nothing remembered yet", a confident lie about the one
               thing this screen exists to report. */
            <div
              class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm"
              data-slot="memory-graph-state"
              data-state={graphState()}
            >
              <Show when={graphState() === "loading"}>
                <span class="opacity-50">Loading the memory graph…</span>
              </Show>
              <Show when={graphState() === "unavailable" ? fault() : undefined}>
                {(f) => (
                  <>
                    <span class="opacity-70">Memory is unavailable right now.</span>
                    <span class="max-w-md opacity-50">{f().reason}</span>
                    <Show when={f().retryable}>
                      <button
                        type="button"
                        data-slot="memory-graph-retry"
                        class="rounded bg-v2-background-bg-layer-02 px-2.5 py-1 text-xs opacity-80 hover:opacity-100"
                        onClick={() => setTick((t) => t + 1)}
                      >
                        Retry
                      </button>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={graphState() === "empty"}>
                <span class="opacity-50">Nothing remembered yet — the graph fills as you chat.</span>
              </Show>
            </div>
          }
        >
          <svg
            ref={svgEl}
            class="flex-1 cursor-grab touch-none select-none active:cursor-grabbing"
            width="100%"
            height="100%"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={() => setSelected(undefined)}
          >
            <g transform={`translate(${view().tx} ${view().ty}) scale(${view().scale})`}>
              {/* edges — the PROJECTION's, so every endpoint is guaranteed to be on the canvas */}
              <For each={projected().edges}>
                {(e) => {
                  const a = () => positions()[e.from]
                  const b = () => positions()[e.to]
                  const active = () => selected() === e.from || selected() === e.to
                  return (
                    <Show when={a() && b()}>
                      <line
                        x1={a()!.x}
                        y1={a()!.y}
                        x2={b()!.x}
                        y2={b()!.y}
                        stroke={active() ? "#eab308" : "currentColor"}
                        // A merged edge stands for many stored ones, and WEIGHT is the only channel a
                        // line has to say so. Logarithmic and capped: 202 passages must read as "more
                        // than three", not as a band two hundred times thicker.
                        stroke-width={edgeWidth(e.count, active())}
                        stroke-opacity={active() ? 0.9 : selected() ? 0.08 : 0.22}
                      />
                    </Show>
                  )
                }}
              </For>
              {/* nodes */}
              <For each={projected().nodes}>
                {(node) => {
                  const p = () => positions()[node.id]
                  const isSel = () => selected() === node.id
                  const isNeighbor = () => neighborIds().has(node.id)
                  const dim = () => selected() !== undefined && !isSel() && !isNeighbor()
                  const hub = () => (isHub(node) ? node : undefined)
                  const row = () => (isHub(node) ? undefined : node.row)
                  // A hub carries no scope of its own unless every member agrees on one — see
                  // `project.ts`. `undefined` paints it neutral rather than borrowing a colour, since
                  // a colour here would be a claim about 202 memories made on the strength of one.
                  const colour = () => {
                    const scope = hub() ? hub()!.scope : row()!.scope
                    return scope === undefined ? "currentColor" : scopeColor(scope)
                  }
                  return (
                    <Show when={p()}>
                      <g
                        transform={`translate(${p()!.x} ${p()!.y})`}
                        class="cursor-pointer"
                        data-slot="memory-graph-node"
                        data-node-kind={hub() ? "hub" : row()!.kind}
                        opacity={dim() ? 0.25 : 1}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setSelected(node.id)
                        }}
                      >
                        {/* SHAPE = kind, COLOUR = scope. Two attributes on two channels; using
                            colour for both is what made a node unreadable.
                            A HUB gets a fourth shape and a DASHED stroke — the one mark on this
                            canvas that is not a memory has to look like it, or the map asserts
                            something the store never said. */}
                        <Show
                          when={hub()}
                          fallback={
                            <Show
                              when={row()!.kind === "entity"}
                              fallback={
                                <Show
                                  when={row()!.kind === "episode"}
                                  fallback={
                                    <rect
                                      x={isSel() ? -6 : -4}
                                      y={isSel() ? -6 : -4}
                                      width={isSel() ? 12 : 8}
                                      height={isSel() ? 12 : 8}
                                      rx={1}
                                      fill="none"
                                      stroke={isSel() ? "#eab308" : colour()}
                                      stroke-width={isSel() ? 2.5 : 1.5}
                                    />
                                  }
                                >
                                  <rect
                                    x={isSel() ? -7 : -5}
                                    y={isSel() ? -7 : -5}
                                    width={isSel() ? 14 : 10}
                                    height={isSel() ? 14 : 10}
                                    transform="rotate(45)"
                                    fill={colour()}
                                    stroke={isSel() ? "#eab308" : "white"}
                                    stroke-width={isSel() ? 2.5 : 1}
                                    stroke-opacity={isSel() ? 1 : 0.5}
                                  />
                                </Show>
                              }
                            >
                              <circle
                                r={isSel() ? 9 : 6}
                                fill={colour()}
                                stroke={isSel() ? "#eab308" : "white"}
                                stroke-width={isSel() ? 2.5 : 1}
                                stroke-opacity={isSel() ? 1 : 0.5}
                              />
                            </Show>
                          }
                        >
                          <polygon
                            points={HEX}
                            transform={isSel() ? "scale(1.4)" : undefined}
                            fill="none"
                            stroke={isSel() ? "#eab308" : colour()}
                            stroke-width={isSel() ? 2 : 1.25}
                            stroke-dasharray="2.5 2"
                            stroke-opacity={0.85}
                          />
                        </Show>
                      </g>
                    </Show>
                  )
                }}
              </For>
            </g>
            {/* LABELS, in SCREEN space — outside the zoomed group on purpose.
                Inside it they scaled with the view: illegible when zoomed out, billboards when zoomed
                in, and "do these two overlap?" had no stable answer to cull on. Here they are always
                11px and `placeLabels` can decide what fits. */}
            <g data-slot="memory-graph-labels">
              <For each={projected().nodes}>
                {(node) => {
                  const at = () => {
                    const p = positions()[node.id]
                    return p ? project(p, view()) : undefined
                  }
                  const isSel = () => selected() === node.id
                  const isNeighbor = () => neighborIds().has(node.id)
                  const dim = () => selected() !== undefined && !isSel() && !isNeighbor()
                  return (
                    <Show when={labelled().has(node.id) && at()}>
                      <text
                        x={at()!.x + 13}
                        y={at()!.y + 4}
                        font-size="11"
                        fill="currentColor"
                        class="pointer-events-none select-none"
                        data-slot="memory-graph-label"
                        data-node-id={node.id}
                        opacity={dim() ? 0.2 : isHub(node) ? 0.6 : 0.8}
                        font-style={isHub(node) ? "italic" : undefined}
                      >
                        {markText(node)}
                      </text>
                    </Show>
                  )
                }}
              </For>
            </g>
          </svg>

          {/* detail panel for the selected memory */}
          <Show when={selectedNode()}>
            {(sel) => (
              <aside
                class="absolute right-0 top-0 h-full w-72 overflow-y-auto border-l border-v2-border-border-muted bg-v2-background-bg-layer-02 p-4 text-sm"
                data-slot="memory-graph-detail"
              >
                <div class="mb-2 flex items-start justify-between gap-2">
                  {/* A hub has a scope BADGE only when every memory in it agrees on one; otherwise it
                      says what it is instead of claiming who can read it. */}
                  <Show
                    when={selectedScope()}
                    fallback={<span class="rounded bg-v2-background-bg-layer-03 px-1.5 py-0.5 text-xs opacity-60">Group</span>}
                  >
                    {(scope) => (
                      <span
                        class="rounded px-1.5 py-0.5 text-xs"
                        style={{ background: scopeColor(scope()) + "33", color: scopeColor(scope()) }}
                      >
                        {scopeLabel(scope(), owners())}
                      </span>
                    )}
                  </Show>
                  <button class="opacity-60 hover:opacity-100" onClick={() => setSelected(undefined)}>
                    <Icon name="close-small" size="large" />
                  </button>
                </div>
                {/* THE HUB EXPLAINS ITSELF, and offers the one action that dissolves it. A mark the
                    user cannot account for is worse than the missing structure it was added to fix —
                    so it names what it stands for, why it is there, and how to see through it. */}
                <Show
                  when={isHubNode(sel())}
                  fallback={
                    <>
                      <p class="mb-1 leading-snug">{rowOf(sel().id)?.text}</p>
                      <div class="mb-3 flex flex-wrap gap-2 text-xs opacity-60">
                        <span>{rowOf(sel().id)?.kind}</span>
                        <span>·</span>
                        <span>{rowOf(sel().id)?.relation}</span>
                        <Show when={rowOf(sel().id)?.source}>
                          <span>·</span>
                          <span>{rowOf(sel().id)?.source}</span>
                        </Show>
                      </div>
                    </>
                  }
                >
                  {(hub) => (
                    <>
                      <p class="mb-1 leading-snug">{hubLabel(hub())}, drawn as one mark.</p>
                      <p class="mb-3 text-xs opacity-60">
                        They are hidden by the {hub().of} filter. Their links are kept so the rest of the map stays
                        connected — nothing here is a relationship NovaClaw invented.
                      </p>
                      <button
                        type="button"
                        data-slot="memory-hub-reveal"
                        class="mb-3 rounded bg-v2-background-bg-layer-03 px-2 py-1 text-xs opacity-80 hover:opacity-100"
                        onClick={() => {
                          toggleKind(hub().of)
                          setSelected(undefined)
                        }}
                      >
                        Show every {hub().of}
                      </button>
                    </>
                  )}
                </Show>
                <Show when={selectedEdges().length > 0} fallback={<p class="text-xs opacity-40">No links.</p>}>
                  <div class="text-xs font-medium opacity-70">Links</div>
                  <ul class="mt-1 flex flex-col gap-1">
                    <For each={selectedEdges()}>
                      {(edge) => (
                        <li>
                          <button class="w-full text-left hover:underline" onClick={() => setSelected(edge.other)}>
                            <span class="opacity-50">
                              {edge.dir} [{edge.type}]
                              {/* A merged edge says how many stored links it stands for; without it,
                                  "1 link" and "202 links" read identically. */}
                              <Show when={edge.count > 1}>{` ×${edge.count}`}</Show>{" "}
                            </span>
                            {truncate(markLabel(edge.other), 32)}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </aside>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
