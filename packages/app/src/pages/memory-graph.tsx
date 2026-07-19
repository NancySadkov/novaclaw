import { A } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { useGlobal } from "@/context/global"
import { useServer, ServerConnection } from "@/context/server"
import { memoryGraph, type MemoryGraph, type MemoryRow } from "@/utils/memory-api"
import { layoutGraph, type Vec } from "./memory-graph/layout"

// The Memory graph viewer (notes/kb-graph-plan.md §5 — the advanced, node-link surface for
// path-tracing) — a Developer-mode page (the home tile is minLevel-gated) that renders the graph
// memory as an interactive node-link diagram over /memory/graph + /memory/neighbors. Dependency-free
// (custom deterministic layout + inline SVG); local-first/airgap-friendly and no npm graph lib. Strings
// stay untranslated on purpose — a Developer diagnostic surface, like Registry/Debug.

const W = 1000
const H = 700
const GRAPH_LIMIT = 600

// Node colour by scope: durable global memory vs a single chat's private memory.
const SCOPE_GLOBAL = "#8b5cf6" // violet — durable, cross-chat
const SCOPE_SESSION = "#22d3ee" // cyan — this chat only
const scopeColor = (scope: string) => (scope === "global" ? SCOPE_GLOBAL : SCOPE_SESSION)
const scopeLabel = (scope: string) => (scope === "global" ? "Always (global)" : scope.startsWith("session:") ? "One chat" : scope)

const truncate = (text: string, n = 40) => (text.length > n ? text.slice(0, n - 1) + "…" : text)

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

  const [graph] = createResource(
    () => {
      const cn = conn()
      return cn ? { cn, dir: directory(), t: tick() } : undefined
    },
    ({ cn, dir }) =>
      memoryGraph(cn.http, { directory: dir, limit: GRAPH_LIMIT }).catch(() => ({ nodes: [], edges: [] }) as MemoryGraph),
  )

  // Deterministic layout, seeded from the per-instance cache (stable across opens); positions written
  // back so a later open reuses them and only new nodes settle.
  const positions = createMemo<Record<string, Vec>>(() => {
    const g = graph()
    if (!g || g.nodes.length === 0) return {}
    const key = conn() ? ServerConnection.key(conn()!) : "default"
    const cached = readCache(key)
    const ids = g.nodes.map((n) => n.id)
    const allCached = ids.every((id) => cached[id])
    const pos = layoutGraph(ids, g.edges, {
      width: W,
      height: H,
      seed: cached,
      // If nothing is new, don't re-simulate — reuse the cached layout verbatim (perfect stability).
      iterations: allCached ? 0 : 300,
    })
    writeCache(key, pos)
    return pos
  })

  const nodeById = createMemo(() => {
    const map = new Map<string, MemoryRow>()
    for (const n of graph()?.nodes ?? []) map.set(n.id, n)
    return map
  })

  const [selected, setSelected] = createSignal<string | undefined>()
  // The set of node ids adjacent to the selected node (both directions) — used to highlight.
  const neighborIds = createMemo(() => {
    const sel = selected()
    const set = new Set<string>()
    if (!sel) return set
    for (const e of graph()?.edges ?? []) {
      if (e.from === sel) set.add(e.to)
      if (e.to === sel) set.add(e.from)
    }
    return set
  })
  const selectedNode = createMemo(() => (selected() ? nodeById().get(selected()!) : undefined))
  const selectedEdges = createMemo(() => {
    const sel = selected()
    if (!sel) return []
    return (graph()?.edges ?? [])
      .filter((e) => e.from === sel || e.to === sel)
      .map((e) => ({ type: e.type, other: e.from === sel ? e.to : e.from, dir: e.from === sel ? "→" : "←" }))
  })

  // --- pan / zoom (a transform on the content group; wheel zooms toward the pointer) ---
  const [view, setView] = createSignal({ tx: 0, ty: 0, scale: 1 })
  let dragging = false
  let last = { x: 0, y: 0 }
  let svgEl: SVGSVGElement | undefined

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = svgEl?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const v = view()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const scale = Math.max(0.2, Math.min(5, v.scale * factor))
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
  const resetView = () => setView({ tx: 0, ty: 0, scale: 1 })

  const count = () => graph()?.nodes.length ?? 0

  return (
    <div class="flex h-full w-full flex-col bg-v2-surface-bg-base text-v2-text-text-base">
      <header class="flex items-center gap-3 border-b border-v2-border-border-faint px-4 py-2.5">
        <A href="/" class="flex items-center gap-1.5 text-sm opacity-70 hover:opacity-100">
          <Icon name="arrow-left" />
          Home
        </A>
        <div class="flex items-center gap-2">
          <Icon name="branch" />
          <h1 class="text-sm font-medium">Memory graph</h1>
        </div>
        <span class="text-xs opacity-50">
          {count()} {count() === 1 ? "memory" : "memories"} · {graph()?.edges.length ?? 0} links
        </span>
        <div class="ml-auto flex items-center gap-3 text-xs">
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_GLOBAL }} /> Global
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_SESSION }} /> Chat
          </span>
          <button class="opacity-70 hover:opacity-100" title="Reset view" onClick={resetView}>
            <Icon name="expand" />
          </button>
          <button class="opacity-70 hover:opacity-100" title="Refresh" onClick={() => setTick((t) => t + 1)}>
            <Icon name="reset" />
          </button>
        </div>
      </header>

      <div class="relative flex min-h-0 flex-1">
        <Show
          when={count() > 0}
          fallback={
            <div class="flex flex-1 items-center justify-center text-sm opacity-50">
              {graph.loading ? "Loading the memory graph…" : "Nothing remembered yet — the graph fills as you chat."}
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
              {/* edges */}
              <For each={graph()?.edges ?? []}>
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
                        stroke-width={active() ? 1.5 : 0.75}
                        stroke-opacity={active() ? 0.9 : selected() ? 0.08 : 0.22}
                      />
                    </Show>
                  )
                }}
              </For>
              {/* nodes */}
              <For each={graph()?.nodes ?? []}>
                {(node) => {
                  const p = () => positions()[node.id]
                  const isSel = () => selected() === node.id
                  const isNeighbor = () => neighborIds().has(node.id)
                  const dim = () => selected() !== undefined && !isSel() && !isNeighbor()
                  return (
                    <Show when={p()}>
                      <g
                        transform={`translate(${p()!.x} ${p()!.y})`}
                        class="cursor-pointer"
                        opacity={dim() ? 0.25 : 1}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setSelected(node.id)
                        }}
                      >
                        <circle
                          r={isSel() ? 9 : 6}
                          fill={scopeColor(node.scope)}
                          stroke={isSel() ? "#eab308" : "white"}
                          stroke-width={isSel() ? 2.5 : 1}
                          stroke-opacity={isSel() ? 1 : 0.5}
                        />
                        <Show when={isSel() || isNeighbor() || count() <= 40}>
                          <text x={11} y={4} font-size="11" fill="currentColor" opacity={0.8}>
                            {truncate(node.name || node.text, 28)}
                          </text>
                        </Show>
                      </g>
                    </Show>
                  )
                }}
              </For>
            </g>
          </svg>

          {/* detail panel for the selected memory */}
          <Show when={selectedNode()}>
            {(sel) => (
              <aside class="absolute right-0 top-0 h-full w-72 overflow-y-auto border-l border-v2-border-border-faint bg-v2-surface-bg-raised p-4 text-sm">
                <div class="mb-2 flex items-start justify-between gap-2">
                  <span
                    class="rounded px-1.5 py-0.5 text-xs"
                    style={{ background: scopeColor(sel().scope) + "33", color: scopeColor(sel().scope) }}
                  >
                    {scopeLabel(sel().scope)}
                  </span>
                  <button class="opacity-60 hover:opacity-100" onClick={() => setSelected(undefined)}>
                    <Icon name="close-small" />
                  </button>
                </div>
                <p class="mb-1 leading-snug">{sel().text}</p>
                <div class="mb-3 flex flex-wrap gap-2 text-xs opacity-60">
                  <span>{sel().kind}</span>
                  <span>·</span>
                  <span>{sel().relation}</span>
                  <Show when={sel().source}>
                    <span>·</span>
                    <span>{sel().source}</span>
                  </Show>
                </div>
                <Show when={selectedEdges().length > 0} fallback={<p class="text-xs opacity-40">No links.</p>}>
                  <div class="text-xs font-medium opacity-70">Links</div>
                  <ul class="mt-1 flex flex-col gap-1">
                    <For each={selectedEdges()}>
                      {(edge) => (
                        <li>
                          <button
                            class="w-full text-left hover:underline"
                            onClick={() => setSelected(edge.other)}
                          >
                            <span class="opacity-50">
                              {edge.dir} [{edge.type}]{" "}
                            </span>
                            {truncate(nodeById().get(edge.other)?.text ?? edge.other, 32)}
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
