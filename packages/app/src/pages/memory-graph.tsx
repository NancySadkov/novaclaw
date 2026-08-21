import { A } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { MemoryRemembered } from "@/components/memory-remembered"
import { SettingsMemoryV2 } from "@/components/settings-v2/memory"
import { Icon } from "@novaclaw/ui/v2/icon"
import { useGlobal } from "@/context/global"
import { useServer, ServerConnection } from "@/context/server"
import { memoryGraph, type MemoryGraph, type MemoryRow } from "@/utils/memory-api"
import { defaultOwner, ownersFor, scopeOwnerName, type MemoryOwner } from "@/apps/memory-owner"
import { type AgentLike } from "@/apps/contacts"
import { listAgents } from "@/apps/agent-list"
import { layoutGraph, type Vec } from "./memory-graph/layout"

// The Memory graph viewer (notes/kb-graph-plan.md §5 — the advanced, node-link surface for
// path-tracing) — renders the graph memory as an interactive node-link diagram over /memory/graph +
// /memory/neighbors. ⚠️ It is NOT gated: this header claimed "a Developer-mode page (the home tile is
// minLevel-gated)" until 2026-08-19, but the owner moved the tile to Normal on 2026-08-12 — "what
// NovaClaw remembers about you is not an expert topic" (`apps/builtins.tsx`). The tile carries no
// `minLevel`, so `app-routes.test.ts` asks nothing of this page, correctly. Dependency-free
// (custom deterministic layout + inline SVG); local-first/airgap-friendly and no npm graph lib. Strings
// stay untranslated on purpose — a Developer diagnostic surface, like Registry/Debug.

const W = 1000
const H = 700
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

  // WHO works here — the same loader the Contacts roster uses, so the two surfaces can never
  // disagree about who exists.
  const [agents] = createResource(ctx, (current) => listAgents(current.sdk.client.v2))
  const owners = createMemo(() => ownersFor(agents() ?? ([] as AgentLike[]), "Shared with everyone"))
  const [ownerKey, setOwnerKey] = createSignal<string | undefined>()
  const owner = createMemo(() => owners().find((entry) => entry.key === ownerKey()) ?? defaultOwner(owners()))

  const [graph] = createResource(
    () => {
      const cn = conn()
      const scopes = owner()?.scopes
      // No owner resolved yet = the roster has not loaded. Querying now would draw the WHOLE graph
      // for a moment and then swap it for one colleague's — a flash of everyone's memories in a view
      // whose entire promise is that they are separate.
      return cn && scopes ? { cn, dir: directory(), scopes, t: tick() } : undefined
    },
    ({ cn, dir, scopes }) =>
      memoryGraph(cn.http, { directory: dir, limit: GRAPH_LIMIT, scopes }).catch(
        () => ({ nodes: [], edges: [] }) as MemoryGraph,
      ),
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
  const hiddenCount = createMemo(() => (graph()?.nodes ?? []).filter((n) => !kindVisible(n.kind)).length)

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

  /**
   * LIST first. "What do you know about me" is answered in sentences; the graph answers "how does
   * it connect", which is the second question. Opening on the graph led with the harder view.
   */
  const [appView, setAppView] = createSignal<"list" | "graph" | "settings">("list")

  const count = () => graph()?.nodes.length ?? 0
  /**
   * How many nodes are actually ON SCREEN — the number the label threshold must use.
   *
   * 🔴 The threshold read `count()`, the TOTAL. Measured 2026-08-12 after ingesting a document:
   * 303 nodes of which 302 were passages, hidden by default, so the canvas held exactly ONE node —
   * and it was drawn UNLABELLED, because 303 > 40. A single anonymous dot on an empty canvas is the
   * worst version of the complaint that opened this work ("no way to see what node represents
   * what"), and it appeared precisely BECAUSE the filter was doing its job.
   */
  const visibleCount = () => (graph()?.nodes ?? []).filter((n) => kindVisible(n.kind)).length

  return (
    <div class="flex h-full w-full flex-col bg-v2-surface-bg-base text-v2-text-text-base">
      <header class="flex items-center gap-3 border-b border-v2-border-border-faint px-4 py-2.5">
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
            onChange={(event) => setOwnerKey(event.currentTarget.value)}
          >
            <For each={owners()}>
              {(entry) => (
                <option value={entry.key}>
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
                  "bg-v2-background-bg-layer-03 text-v2-text-text-strong": appView() === entry.id,
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
          {count()} {count() === 1 ? "memory" : "memories"} · {graph()?.edges.length ?? 0} links
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

      <div class="relative flex min-h-0 flex-1" classList={{ hidden: appView() !== "graph" }}>
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
                  // An edge whose endpoint is filtered out would be a line to nowhere.
                  const shown = () =>
                    kindVisible(nodeById().get(e.from)?.kind) && kindVisible(nodeById().get(e.to)?.kind)
                  const a = () => (shown() ? positions()[e.from] : undefined)
                  const b = () => (shown() ? positions()[e.to] : undefined)
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
                  // Hidden at RENDER, not before layout — see `positions`: filtering the layout
                  // input would re-simulate and move every remaining node on each toggle.
                  const p = () => (kindVisible(node.kind) ? positions()[node.id] : undefined)
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
                        {/* SHAPE = kind, COLOUR = scope. Two attributes on two channels; using
                            colour for both is what made a node unreadable. */}
                        <Show
                          when={node.kind === "entity"}
                          fallback={
                            <Show
                              when={node.kind === "episode"}
                              fallback={
                                <rect
                                  x={isSel() ? -6 : -4}
                                  y={isSel() ? -6 : -4}
                                  width={isSel() ? 12 : 8}
                                  height={isSel() ? 12 : 8}
                                  rx={1}
                                  fill="none"
                                  stroke={isSel() ? "#eab308" : scopeColor(node.scope)}
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
                                fill={scopeColor(node.scope)}
                                stroke={isSel() ? "#eab308" : "white"}
                                stroke-width={isSel() ? 2.5 : 1}
                                stroke-opacity={isSel() ? 1 : 0.5}
                              />
                            </Show>
                          }
                        >
                          <circle
                            r={isSel() ? 9 : 6}
                            fill={scopeColor(node.scope)}
                            stroke={isSel() ? "#eab308" : "white"}
                            stroke-width={isSel() ? 2.5 : 1}
                            stroke-opacity={isSel() ? 1 : 0.5}
                          />
                        </Show>
                        <Show when={isSel() || isNeighbor() || visibleCount() <= 40}>
                          <text x={13} y={4} font-size="11" fill="currentColor" opacity={0.8}>
                            {nodeLabel(node)}
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
                    {scopeLabel(sel().scope, owners())}
                  </span>
                  <button class="opacity-60 hover:opacity-100" onClick={() => setSelected(undefined)}>
                    <Icon name="close-small" size="large" />
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
                          <button class="w-full text-left hover:underline" onClick={() => setSelected(edge.other)}>
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
