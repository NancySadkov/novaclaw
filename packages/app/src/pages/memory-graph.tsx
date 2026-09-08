import { A, useSearchParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { MemoryRemembered } from "@/components/memory-remembered"
import { SettingsMemoryV2 } from "@/components/settings-v2/memory"
import { Icon } from "@novaclaw/ui/v2/icon"
import * as Timestamp from "@novaclaw/schema/time"
import { useGlobal } from "@/context/global"
import { useServer, ServerConnection } from "@/context/server"
import {
  memoryClaimStatus,
  memoryGraph,
  memoryUsageDetail,
  type MemoryGraph,
  type MemoryRow,
  type UsageAccess,
  type UsageCounts,
} from "@/utils/memory-api"
import { instanceDiagnosis } from "@/utils/resource-api"
import { showToast } from "@/utils/toast"
import { memoryFaultDetail, memoryUnavailable } from "@/utils/memory-health"
import {
  defaultFilter,
  describeScope,
  isNarrowed,
  matches,
  toggleKind as toggleKindIn,
  type MemoryFilter,
} from "@/utils/memory-filter"
import { LENSES, lensByID, statusBadge, type LensID } from "@/utils/memory-lens"
import { createMemoryActivity } from "./memory-graph/activity-live"
import { MemoryActivityFeedRail } from "./memory-graph/activity-feed"
import { FLARE_MS, RANK_RING_R, rankPop } from "./memory-graph/activity"
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
import { instanceGlobalDirectory } from "@/utils/routing-directory"

// The Memory graph viewer (the advanced, node-link surface for
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
/**
 * WHAT A FLARE MEANS, by colour — the same three the feed's tones use.
 *
 * Gold for something LEARNED (the skin's accent, and the colour this app already spends on "new"),
 * cyan for an EDIT in place, slate for a RETIREMENT. Deliberately not red: nothing here is an
 * error, and a corrected memory is the system working rather than failing.
 */
const FLARE_COLOUR = { new: "#e0a33e", edit: "#22d3ee", retire: "#94a3b8" } as const

/**
 * WHAT ARCHIVING MEANS, said where the button is.
 *
 * ⚠️ Not "delete". An archived claim is still in the cabinet and still reachable from this map; what
 * changes is that recall stops handing it to the model. Saying "archive" alone would leave a user
 * guessing which of the two it was, and the two have very different consequences for a fact they
 * might want back.
 */
const ARCHIVE_MEANS = "Kept, but never recalled. You can restore it."
const RESTORE_MEANS = "Recalled again, from now on."

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

/**
 * ⚠️ A shape encoding nobody can decode is a different mystery, not a fix.
 *
 * 🔴 `claim` was missing from this list, and the list IS the only way to turn a kind on. The canvas
 * asks `filter.kinds.has(kind)` for every kind the store has, so a kind with no chip and no place in
 * the default set can never be drawn — every claim was folded into a hub, and the inspector's claim
 * half (identity, timeline, Archive/Restore) was reachable only by pressing "Show every claim" on
 * that hub. It draws as the square, which is what the canvas already gave it as a fallback.
 *
 * ⚠️ `source` — a citation node — deliberately still has no chip, and it draws as a square too. It is
 * scaffolding rather than something a person browses, and giving it a chip beside `claim` would put
 * two different kinds behind one shape, which is the mystery this comment starts by refusing.
 */
const KIND_LEGEND = [
  { kind: "entity", label: "Entity — a thing NovaClaw knows about" },
  { kind: "episode", label: "Episode — something that happened" },
  { kind: "claim", label: "Claim — a fact with an identity, so a later one can correct it" },
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
  const language = useLanguage()
  const global = useGlobal()
  const server = useServer()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const directory = () => {
    const path = ctx()?.sync.data.path
    return instanceGlobalDirectory(path)
  }
  const [tick, setTick] = createSignal(0)
  /**
   * ARCHIVE / RESTORE, and the one id currently in flight.
   *
   * ⚠️ **`false` is rendered as a REFUSAL, not as success.** The endpoint answers whether the status
   * actually moved, and a claim that is gone or already in that state answers `false`. Drawing the
   * change anyway is the shape of defect this app has already been bitten by: a message that says the
   * thing happened while the store disagrees.
   *
   * ⚠️ The re-read is a `tick`, not a local edit of the row. The store is the authority on a claim's
   * status — the same reconcile-then-animate rule the activity overlay follows — and patching the
   * row here would make the canvas and the cabinet disagree the first time a write is refused.
   */
  /**
   * 🔴 "WHY IS THIS HERE" — the access ledger's own answer, on demand.
   *
   * `/memory/usage/detail` answered correctly and had no caller, so the one question a person asks
   * about a memory they did not expect to see — *where did this come from, and has it ever been any
   * use?* — had no surface at all. It is behind a disclosure rather than always on, per principle
   * 12(d): the row states what is in force in one line, and everything longer is asked for.
   *
   * ⚠️ Fetched per open, never cached across selections. The ledger changes on every recall, and a
   * stale answer here is a claim about a measurement rather than the measurement.
   */
  const [whyOpen, setWhyOpen] = createSignal<string | undefined>()
  const [why] = createResource(
    () => {
      const cn = conn()
      const id = whyOpen()
      return cn && id ? { cn, dir: directory(), id } : undefined
    },
    ({ cn, dir, id }) =>
      memoryUsageDetail(cn.http, { directory: dir, id })
        .then((answer) => ({ ok: true, ...answer }) as const)
        .catch(
          () => ({ ok: false, usage: null as UsageCounts | null, accesses: [] as readonly UsageAccess[] }) as const,
        ),
  )

  const [lifecycleBusy, setLifecycleBusy] = createSignal<string | undefined>()
  const setLifecycle = async (id: string) => {
    const cn = conn()
    const row = rowOf(id)
    if (!cn || !row) return
    const next = row.status === "archived" ? "active" : "archived"
    setLifecycleBusy(id)
    try {
      const moved = await memoryClaimStatus(cn.http, { directory: directory(), id, status: next })
      if (!moved)
        showToast({
          variant: "error",
          title: "Nothing changed",
          description: "That claim is already in that state, or it is no longer in the cabinet.",
        })
      setTick((value) => value + 1)
    } catch (error) {
      showToast({
        variant: "error",
        title: next === "archived" ? "Could not archive" : "Could not restore",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setLifecycleBusy(undefined)
    }
  }

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
  const transportFault = (): GraphFault | undefined => {
    const current = load()
    return current?.status === "unavailable" ? current.fault : undefined
  }

  /**
   * THE SECOND WAY A BROKEN ENGINE LOOKS LIKE AN EMPTY CABINET.
   *
   * The `/memory/*` read handlers fold a `MemoryError` into an empty result and answer **200**
   * (`handlers/memory.ts`: `Effect.orElseSucceed(() => ({ nodes: [], edges: [] }))`). That degrade is
   * deliberate and right — an engine outage must not fail a turn — but it means a dead engine and an
   * empty one send the same bytes, so no amount of care on the transport path can tell them apart.
   * Only the diagnosis board can, and the Remembered list has been asking it all along. The Graph did
   * not: the same broken instance said "memory is unavailable" on one tab and "Nothing remembered yet
   * — the graph fills as you chat" on the next.
   *
   * ⚠️ Keyed on the GRAPH having settled, not on the connection, for the same reason the list is: the
   * engine opens lazily, so a board read at mount reports "not opened yet" (`unknown`, never
   * `problem`) and this would fall through to the empty state exactly as before. The fetch is what
   * demands the subsystem; only after it resolves does the board know anything.
   */
  const [health, healthActions] = createResource(
    () => {
      const cn = conn()
      const current = load()
      return cn && current ? { cn, settled: current.status } : undefined
    },
    ({ cn }) => instanceDiagnosis(cn.http).catch(() => undefined),
  )
  /** Either way of being broken, as one calm sentence — transport first, since it is the more specific. */
  const fault = (): GraphFault | undefined => {
    const transport = transportFault()
    if (transport) return transport
    if (!memoryUnavailable(health())) return undefined
    const detail = memoryFaultDetail(health())
    return { reason: detail ?? "The memory engine is not running on this instance.", retryable: true }
  }
  /** One user action, two refreshes: re-ask the engine, then re-read the board it feeds. */
  const retry = () => {
    setTick((t) => t + 1)
    void healthActions.refetch()
  }

  /**
   * THE LIVE OVERLAY — what the store is doing, as it does it.
   *
   * 🔴 **Events, never polling.** The UI is a thin client that may be on another machine, so it is
   * TOLD what happened rather than asking every few seconds whether anything did. It rides the
   * shell's single `GET /global/event` subscription (`memory-graph/activity-live.ts`); opening this
   * page adds no connection and closing it removes no work from the write path, which is both
   * halves of the P2 gate.
   *
   * ⚠️ **An event is a NOTICE, not a row.** `memory.claim.recorded` carries ids and a truncated
   * caption — deliberately, because a bus is not a second copy of the store — so a write flares
   * instantly and the NODE it is about appears when the debounced re-read lands. That is why both
   * callbacks below re-read rather than patching the graph in place: a client-side patch would be a
   * second, drifting implementation of what the engine already computed.
   */
  const [listRevision, setListRevision] = createSignal(0)
  const reread = () => {
    setTick((t) => t + 1)
    setListRevision((r) => r + 1)
  }
  const activity = createMemoryActivity({
    onReconcile: reread,
    onRefresh: reread,
    // 🔴 A flare's clock starts when its MARK EXISTS. A written memory is captioned within
    // milliseconds and drawn only after the debounced re-read, so timing the flare from the event
    // spent most of it — and on a slow read, all of it — on an empty patch of canvas.
    isVisible: (id) => positions()[id] !== undefined && nodeById().has(id),
  })
  /**
   * RECONCILE BEFORE ANIMATING. The feed suppresses flares from the moment the stream drops until
   * this fires, so nothing highlights a node the canvas has not re-read yet.
   *
   * ⚠️ Keyed on the graph resource SETTLING, not on the fetch being issued. "We asked" and "we know"
   * are different facts, and animating on the first would put the flare back in the gap it was
   * moved out of.
   */
  createEffect(
    on(
      () => graph.loading,
      (loading) => {
        if (!loading) activity.synced()
      },
    ),
  )

  const live = () => activity.state()
  /** ⚠️ Reduced motion drops FLARES, DRIFT and DIMMING. Captions and state changes stay. */
  const motion = () => !activity.reducedMotion()
  const recall = () => live().recall
  const recallRank = (id: string) => recall()?.ranks.get(id)
  const flareOf = (id: string) => live().flares.get(id)
  /**
   * Is this mark retired?
   *
   * TWO sources, on purpose: the store's own `status` (authoritative, arrives with the next fetch)
   * and what this session just watched retire (instant, from the event). Neither alone is enough —
   * the first is late by one round trip, and the second is empty for everything that retired before
   * the page was opened.
   */
  const isRetired = (row: MemoryRow | undefined) =>
    row !== undefined && (row.status === "superseded" || row.status === "archived" || live().retired.has(row.id))

  /**
   * ONE FILTER, read by the Map and by the Remembered list (`utils/memory-filter.ts`).
   *
   * 🔴 It lives HERE, above both views, because this page has twice shipped two surfaces answering
   * the same question separately and disagreeing — the roster, and the memory-health signal. A filter
   * is the same hazard and quieter: each view would show a different subset of one cabinet with
   * nothing on screen saying they were answering different questions.
   *
   * Passages are OFF by default: measured on a real instance they were 202 of 281 nodes, and the
   * graph reads as a wall of identical marks with them on. The chip shows its off state and the
   * header counts what is hidden, so it is a default rather than a concealment.
   */
  const [filter, setFilter] = createSignal<MemoryFilter>(defaultFilter())
  const kindVisible = (kind?: string) => filter().kinds.has(kind ?? "entity")
  const toggleKind = (kind: string) => setFilter((current) => toggleKindIn(current, kind))
  const setQuery = (query: string) => setFilter((current) => ({ ...current, query }))
  /**
   * THE LIFECYCLE LENS, shared by both views like everything else in this header.
   *
   * ⚠️ It replaces a `Current / Incl. forgotten` toggle that was **inert** — `matches()` never read
   * its field and no caller ever passed `includeInvalid`, so it changed its own label and nothing
   * else. The four lenses are the questions the claim lifecycle can actually answer, and the one it
   * cannot (`Never used`) says so rather than rendering an empty list (`utils/memory-lens.ts`).
   */
  const lens = () => lensByID(filter().lens)
  const setLens = (id: LensID) => setFilter((current) => ({ ...current, lens: id }))

  /**
   * WHAT IS ON THE CANVAS — the visible projection, not the raw graph.
   *
   * Hiding a kind used to be a render-time skip: the hidden nodes still pulled on the layout, and any
   * edge touching one was simply not drawn. `memory-graph/project.ts` has the full reasoning; the
   * short version is that an ingested document's extracted entities reach it ONLY through passages,
   * so the default view kept the marks and deleted the structure.
   *
   * ⚠️ **The KIND chips fold; the SEARCH does not.** They are different questions and it matters which
   * mechanism each gets. Hiding a kind is "I am not interested in these", so the hidden ones collapse
   * into an honest hub and the structure survives. A text query is "where is this", and removing
   * everything that does not match would delete the very connections the Map exists to show — you
   * would find your memory and lose what it is attached to. So search HIGHLIGHTS here and FILTERS in
   * the list, which is the surface whose job is answering "what do you remember".
   */
  const projected = createMemo(() =>
    projectGraph(loaded()?.nodes ?? [], loaded()?.edges ?? [], (kind) => kindVisible(kind)),
  )

  /**
   * What the Remembered list is showing, reported up by the list itself.
   *
   * ⚠️ Not recomputed here. The list owns its own fetch on purpose — the two callers refresh on
   * different events — so a count derived from a second fetch would be a second number about one
   * cabinet, free to disagree with the first.
   */
  const [listCounts, setListCounts] = createSignal<{ visible: number; loaded: number; total: number | undefined }>({
    visible: 0,
    loaded: 0,
    total: undefined,
  })
  const listMatchCount = () => listCounts().visible

  /** Marks the current query picks out. Empty query = empty set, never "everything". */
  const matched = createMemo<ReadonlySet<string>>(() => {
    const current = filter()
    if (current.query.trim().length === 0) return new Set<string>()
    const hits = new Set<string>()
    for (const row of loaded()?.nodes ?? []) if (matches(row, current)) hits.add(row.id)
    return hits
  })
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

  /**
   * WHAT HAPPENED TO THIS CLAIM, in both directions.
   *
   * ⚠️ Derived from the rows already on the canvas, because there is no history ENDPOINT: core's
   * engine has `claimHistory` and the HTTP surface does not expose it. So this shows the links that
   * are genuinely reachable — the claim that replaced this one, and the ones this one replaced —
   * and says nothing about anything older. A timeline that invented the missing steps would be the
   * confident-lie failure this page keeps having to unlearn.
   */
  const timeline = (id: string): readonly { readonly label: string; readonly id: string | undefined }[] => {
    const row = rowOf(id)
    if (!row) return []
    const steps: { label: string; id: string | undefined }[] = []
    if (row.supersededBy) steps.push({ label: "Replaced by", id: row.supersededBy })
    for (const other of loaded()?.nodes ?? []) {
      if (other.supersededBy === id) steps.push({ label: "Replaces", id: other.id })
    }
    if (row.status === "archived") steps.push({ label: "Archived — not recalled, still here.", id: undefined })
    if (row.status === "needs_review")
      steps.push({ label: "Flagged — its source moved, so the citation is stale.", id: undefined })
    return steps
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
  /**
   * WHICH MARKS STEP BACK — one predicate, read by the shapes AND by the labels.
   *
   * ⚠️ It was two copies of the same expression, and this slice adds a third reason to dim. Three
   * copies of a rule is how a label ends up bright beside a faded mark: the two would have to be
   * edited together forever, and nothing on screen would say they had drifted.
   *
   * THREE ways of asking "which of these": a selection, a search, and now a RECALL. A mark that
   * answers none of them steps back for the ones that do.
   */
  const dimmed = (id: string) => {
    if (selected() !== undefined && selected() !== id && !neighborIds().has(id)) return true
    if (matched().size > 0 && !matched().has(id)) return true
    // ⚠️ Reduced motion drops the GLOBAL DIMMING, which is the recall's only large visual gesture.
    // The ranks are still badged on the hits, so the answer survives without the movement.
    if (motion() && recall() !== undefined && recallRank(id) === undefined) return true
    return false
  }

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

  /**
   * NEIGHBORHOOD FOCUS — the selection, projected onto the other view.
   *
   * 🔴 Selecting and focusing are ONE act here, not two. A separate "Focus" button would be a second
   * concept for a person to hold, and the roster's lesson is that a legible surface is one somebody
   * can name what they are looking at on. So clicking a mark focuses its neighborhood, and the header
   * says so with a Clear beside it — what is in force, in one line, per principle 12.
   *
   * ⚠️ The two views focus DIFFERENTLY on purpose, the same asymmetry search has. The Map DIMS,
   * because narrowing the drawing to a neighborhood throws away the context that answers "how does
   * this connect" — you would be left looking at the answer with the question deleted. The list
   * FILTERS, because its job is "what do you remember" and a list of everything is not an answer to
   * "what connects to this".
   *
   * ⚠️ HUBS ARE EXCLUDED from what the list is told. A hub is not a memory; passing its synthetic id
   * to a surface that shows stored rows would silently match nothing and read as an empty
   * neighborhood.
   */
  const focusIDs = createMemo<ReadonlySet<string> | undefined>(() => {
    const sel = selected()
    if (!sel) return undefined
    const ids = new Set<string>()
    const keepReal = (id: string) => {
      const node = nodeById().get(id)
      if (node && !isHub(node)) ids.add(id)
    }
    keepReal(sel)
    for (const id of neighborIds()) keepReal(id)
    return ids
  })
  /** What the focus is OF, in the user's words — never the raw id. */
  const focusLabel = () => {
    const node = selectedNode()
    if (!node) return undefined
    return truncate(isHub(node) ? hubLabel(node) : node.row.name?.trim() || node.row.text, 40)
  }
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

  let canvasEl: HTMLDivElement | undefined
  const measure = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    // A hidden pane reports 0x0; keeping the last real size beats fitting to nothing.
    if (rect.width > 0 && rect.height > 0) setViewport({ width: rect.width, height: rect.height })
  }
  const remeasure = () => {
    if (canvasEl) measure(canvasEl)
  }
  /**
   * THREE INDEPENDENT SIGNALS, because one of them was measured inert.
   *
   * 🔴 On 2026-08-25, in the web build under the Browser pane, a `ResizeObserver` armed on this canvas
   * never delivered a single callback — not across the `display: none` → visible transition, and not
   * across a DOM-originated layout change from 638px to 300px, which is the case an observer exists
   * for. A second observer armed by hand from the console behaved identically, so it is not this
   * component's wiring. ⚠️ **What that does NOT establish** is that `ResizeObserver` is broken in
   * Electron or in an ordinary browser; that surface has not been measured, and six other call sites
   * in this app use `createResizeObserver`. The observer therefore STAYS — it is correct where it
   * works — and a measurement this page depends on simply stops resting on it alone.
   *
   * `window.resize` covers the case that actually resizes this pane (the window), and the visibility
   * effect below covers the first measurement. Each is cheap, and `measure` is idempotent.
   */
  const attachCanvas = (el: HTMLDivElement) => {
    canvasEl = el
    measure(el)
    const onResize = () => measure(el)
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
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

  /**
   * OPEN ONE MEMORY IN THE INSPECTOR — the one act the list, the feed and the map all perform.
   *
   * ⚠️ It switches to the Map rather than opening a second detail panel in the list. The inspector
   * shows relationships, and relationships are what the Map is; a panel in the list would be the
   * same information with the picture that explains it removed. The camera follows the selection on
   * its own (the `centerOn` effect below), so a mark chosen from a caption is never off-screen.
   */
  const inspect = (id: string) => {
    setSelected(id)
    setAppView("graph")
  }

  /**
   * 🔴 MEASURE WHEN THE PANE BECOMES VISIBLE. Found by running the app, not by any test.
   *
   * The page opens on Remembered, so the canvas carries Tailwind's `hidden` (`display: none`) at mount.
   * A `display: none` element generates no CSS box, so the ref's own `getBoundingClientRect()` is 0x0
   * — and the `ResizeObserver` armed on it **never fires**, not even when the class comes off.
   * Instrumented live on 2026-08-25: the observer logged its `observe(memory-graph-canvas, w=0)` and
   * never delivered a single callback, so `viewport` stayed `{0,0}` for the life of the page. The
   * canvas then drew at `translate(0 0) scale(1)` into a 1278x591 pane with zero labels — every
   * symptom the camera and label work was supposed to have fixed, in the shipped app, with the whole
   * suite green.
   *
   * ⚠️ The RESIZE OBSERVER STAYS. It is right for every LATER change and wrong only for the first
   * one, because at arming time there was nothing to observe. This is the other half, not a
   * replacement.
   *
   * The second pass on the next frame is the load-bearing one: this effect and the `classList` that
   * un-hides the pane are both Solid effects, and nothing orders them. The synchronous call is what
   * covers the case where the class won that race; the frame is what covers the case where it did not.
   */
  createEffect(
    on(appView, (current) => {
      if (current !== "graph") return
      remeasure()
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(remeasure)
    }),
  )

  const count = () => loaded()?.nodes.length ?? 0

  /**
   * What to say when the server sent a SLICE — one chip, with the detail on hover.
   *
   * ⚠️ `undefined` when the field is absent, which is what an instance older than the field sends.
   * Inventing a notice from a missing field would be the same class of lie as the empty cabinet: a
   * confident statement about something nobody reported.
   */
  const sliceNotice = (): { label: string; title: string } | undefined => {
    const slice = loaded()?.slice
    if (!slice?.partial) return undefined
    if (slice.reason === "scan-capped")
      return {
        label: "partial view",
        title: `This instance holds more memories than one read can gather. Showing ${slice.returned}.`,
      }
    return {
      label: `${slice.omitted} not shown`,
      title:
        `Showing ${slice.returned} of ${slice.total}. The most connected memories come first, ` +
        `with room kept for the newest — so a large document cannot crowd out everything else.`,
    }
  }

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
    const hits = matched()
    const candidates: LabelCandidate[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      const at = screen[i]!
      if (Number.isNaN(at.x)) continue
      const priority = isHub(node)
        ? Priority.Hub
        : node.id === sel
          ? Priority.Selected
          : // A SEARCH HIT outranks a neighbour: the user asked for these by name, and picking out
            // marks they cannot read would answer the question with dots. This is the rung reserved
            // for it (`labels.ts` — `RecallHit`), now that something fills it.
            hits.has(node.id)
            ? Priority.RecallHit
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
    if (transportFault()) return "unavailable"
    if (count() > 0) return "ready"
    // ⚠️ An empty answer is not yet an empty CABINET. The server returns 200 with no rows both when
    // there is nothing to remember and when the engine is broken, so "empty" may only be claimed once
    // the board has ruled the second one out — otherwise a dead engine flashes "Nothing remembered
    // yet" for as long as the diagnosis takes, which is the exact sentence this work exists to delete.
    if (health.loading && health.latest === undefined) return "loading"
    return fault() ? "unavailable" : "empty"
  }

  return (
    <div class="flex h-full w-full flex-col bg-v2-background-bg-base text-v2-text-text-base">
      <header class="flex items-center gap-3 border-b border-v2-border-border-muted px-4 py-2.5">
        <A href="/" class="flex items-center gap-1.5 text-sm opacity-70 hover:opacity-100">
          <Icon name="arrow-left" size="large" />
          {language.t("memoryGraph.page.home")}
        </A>
        <div class="flex items-center gap-2">
          <Icon name="branch" size="large" />
          <h1 class="text-sm font-medium">{language.t("memoryGraph.page.memory")}</h1>
        </div>
        {/* WHOSE memory. The app used to show one undifferentiated pile, which was the only honest
            rendering while there was one pile; now every memory belongs to a colleague, to one chat
            or to the household, and a view that hid that would be the last place still claiming the
            old model. Nova is included like anyone else — it is not a super-user of its colleagues'
            cabinets, it just has one of its own. */}
        <label class="flex items-center gap-1.5 text-[11px] opacity-80" data-slot="memory-owner-picker">
          <span class="opacity-70">{language.t("memoryGraph.page.whose")}</span>
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
                  {entry.label}
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

        {/* SEARCH, on both views. It sits in the shared header rather than inside either one, because
            it IS shared — the same query narrows the list and picks out the marks. A copy per view is
            how the two would drift apart. Hidden on Settings, which has nothing to search. */}
        <Show when={appView() !== "settings"}>
          <label class="flex items-center gap-1.5" data-slot="memory-search">
            <input
              type="search"
              value={filter().query}
              placeholder={language.t("memoryGraph.page.searchMemories")}
              aria-label={language.t("memoryGraph.page.searchMemories")}
              class="w-40 rounded bg-v2-background-bg-layer-01 px-2 py-1 text-[11px] placeholder:opacity-40"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            {/* The COUNT is the whole point of a search that highlights rather than hides: without it
                a query that matches nothing looks identical to a query that matched something
                off-screen. */}
            <Show when={filter().query.trim().length > 0}>
              <span class="text-[11px] opacity-60" data-slot="memory-search-count">
                {appView() === "graph" ? matched().size : listMatchCount()} found
              </span>
            </Show>
          </label>
          {/* THE LENS. Four questions, one row, and the one in force says what it means underneath
              — principle 12(d): what is in force in ONE line, the rest on demand (the `title`). */}
          <div
            class="flex items-center gap-0.5 rounded-md bg-v2-background-bg-layer-01 p-0.5 text-[11px]"
            data-slot="memory-lens"
            data-lens={filter().lens}
          >
            <For each={LENSES}>
              {(entry) => (
                <button
                  type="button"
                  data-slot="memory-lens-tab"
                  data-lens={entry.id}
                  aria-pressed={filter().lens === entry.id}
                  title={entry.hint}
                  onClick={() => setLens(entry.id)}
                  class="rounded px-2 py-1"
                  classList={{
                    "bg-v2-background-bg-layer-03 text-v2-text-text-base": filter().lens === entry.id,
                    "opacity-60 hover:opacity-100": filter().lens !== entry.id,
                  }}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>
          <span class="max-w-56 truncate text-[11px] opacity-50" data-slot="memory-lens-hint" title={lens().hint}>
            {lens().hint}
          </span>
        </Show>

        {/* FOCUS, stated. A view silently showing a neighborhood instead of a cabinet is the same
            class of lie as the empty one — true of what is on screen, wrong as an answer. So it says
            what it is showing and offers the way out in the same breath (principle 12(d)). */}
        <Show when={appView() !== "settings" ? focusLabel() : undefined}>
          {(label) => (
            <span
              class="flex items-center gap-1 rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px]"
              data-slot="memory-focus"
            >
              <span class="opacity-70">
                {language.t("memoryGraph.page.connectedTo")} <span class="opacity-100">{label()}</span>
              </span>
              <button
                type="button"
                data-slot="memory-focus-clear"
                aria-label={language.t("memoryGraph.page.showEverythingAgain")}
                class="opacity-60 hover:opacity-100"
                onClick={() => setSelected(undefined)}
              >
                <Icon name="close-small" size="small" />
              </button>
            </span>
          )}
        </Show>

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
                            <rect
                              x={-4}
                              y={-4}
                              width={8}
                              height={8}
                              rx={1}
                              fill="none"
                              stroke="currentColor"
                              stroke-width={1.5}
                            />
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
        {/* 🔴 SAY WHEN THIS IS A CORNER OF THE MAP. `n memories` beside a graph the server truncated
            reads as "this is everything", and the count is even true — of what arrived. The server
            now reports how it chose (`core/kb-graph/graph-slice.ts`); without that line the client
            cannot tell a complete graph from a slice, because both are just n rows. */}
        <Show when={appView() === "graph" ? sliceNotice() : undefined}>
          {(notice) => (
            <span
              class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px] opacity-70"
              data-slot="memory-graph-slice"
              data-reason={loaded()?.slice?.reason}
              title={notice().title}
            >
              {notice().label}
            </span>
          )}
        </Show>
        <div class="ml-auto flex items-center gap-3 text-xs">
          {/* Three scopes, three marks. The legend used to name two because there WERE two; leaving
              it at two after the roster landed would be the one place still describing the old model
              — and a colour with no legend entry is a mystery, not a hint. */}
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_GLOBAL }} />{" "}
            {language.t("memoryGraph.page.shared")}
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_AGENT }} />{" "}
            {language.t("memoryGraph.page.itsOwn")}
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_SESSION }} />{" "}
            {language.t("memoryGraph.page.oneChat")}
          </span>
          <button
            class="opacity-70 hover:opacity-100"
            title={language.t("memoryGraph.page.resetView")}
            onClick={resetView}
          >
            <Icon name="expand" size="large" />
          </button>
          <button class="opacity-70 hover:opacity-100" title="Refresh" onClick={() => setTick((t) => t + 1)}>
            <Icon name="reset" size="large" />
          </button>
        </div>
      </header>

      {/* One ROW: the view on the left, the activity rail on the right. The rail is a sibling of
          the views rather than an overlay on one of them, so it never covers the map's inspector
          and it is present whichever view you are reading. */}
      <div class="flex min-h-0 flex-1 overflow-hidden">
        {/* The Remembered list, in the app where a person actually asks "what do you know about me".
          It owns its own fetch, so switching views does not depend on the graph having loaded. */}
        <Show when={appView() === "list"}>
          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* The list obeys the same picker as the graph: two views of ONE colleague's memory,
              never one scoped and one not. */}
            <MemoryRemembered
              owner={owner()}
              filter={filter()}
              revision={listRevision()}
              onCounts={setListCounts}
              restrictTo={focusIDs()}
              restrictLabel={focusLabel()}
              onClearRestrict={() => setSelected(undefined)}
              onInspect={inspect}
            />
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
                  <span class="opacity-50">{language.t("memoryGraph.page.loadingTheMemoryGraph")}</span>
                </Show>
                <Show when={graphState() === "unavailable" ? fault() : undefined}>
                  {(f) => (
                    <>
                      <span class="opacity-70">{language.t("memoryGraph.page.memoryIsUnavailableRightNow")}</span>
                      <span class="max-w-md opacity-50">{f().reason}</span>
                      <Show when={f().retryable}>
                        <button
                          type="button"
                          data-slot="memory-graph-retry"
                          class="rounded bg-v2-background-bg-layer-02 px-2.5 py-1 text-xs opacity-80 hover:opacity-100"
                          onClick={retry}
                        >
                          {language.t("memoryGraph.page.retry")}
                        </button>
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={graphState() === "empty"}>
                  <span class="opacity-50">{language.t("memoryGraph.page.nothingRememberedYetTheGraphFills")}</span>
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
                    const dim = () => dimmed(node.id)
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
                          data-node-id={node.id}
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
                {/* THE LIVE OVERLAY, drawn OVER the marks and in PLANE space so it travels with them.
                  🔴 SMIL (`<animate>`), not CSS. Two reasons, both learned the hard way on this page:
                  a stylesheet imported from a `.tsx` is UNLAYERED and outranks every Tailwind
                  utility it collides with, and `getComputedStyle` during an unticked transition
                  reads the START value — so a CSS animation here would be both a cascade hazard and
                  unverifiable from the DOM. An `<animate>` element is inspectable: its presence IS
                  the animation, which is what a test and a person can both check.
                  ⚠️ Under reduced motion no flare element is created at all (the fold never records
                  one), so there is nothing here to suppress a second time. */}
                <g data-slot="memory-graph-overlay" class="pointer-events-none">
                  <For each={projected().nodes}>
                    {(node) => {
                      const p = () => positions()[node.id]
                      const row = () => (isHub(node) ? undefined : node.row)
                      const flare = () => flareOf(node.id)
                      const retiredMark = () => isRetired(row())
                      return (
                        <Show when={p() && (flare() || retiredMark())}>
                          <g transform={`translate(${p()!.x} ${p()!.y})`}>
                            {/* RETIRED: a dashed ring that STAYS. It is a state, not an event, so it
                              survives reduced motion and outlives the flare that announced it —
                              and the mark keeps its place on the map, because a corrected claim is
                              history you can still reach, not a node that was deleted. */}
                            <Show when={retiredMark()}>
                              <circle
                                data-slot="memory-graph-retired"
                                data-node-id={node.id}
                                r={12}
                                fill="none"
                                stroke="#94a3b8"
                                stroke-width={1.25}
                                stroke-dasharray="2 3"
                                opacity={0.55}
                              />
                            </Show>
                            <Show when={flare()}>
                              {(mark) => (
                                <circle
                                  data-slot="memory-graph-flare"
                                  data-node-id={node.id}
                                  data-tone={mark().tone}
                                  r={7}
                                  fill="none"
                                  stroke={FLARE_COLOUR[mark().tone]}
                                  stroke-width={2}
                                  opacity={0.95}
                                >
                                  {/* ⚠️ Both animations START at the visible value, so a frozen
                                    timeline (a hidden tab) leaves a static ring that the pruner
                                    removes on schedule. The degradation is "no movement", never
                                    "no mark" — see `rankPop` for the measurement that settled it. */}
                                  <animate attributeName="r" from="7" to="26" dur={`${FLARE_MS}ms`} fill="freeze" />
                                  <animate
                                    attributeName="opacity"
                                    from="0.95"
                                    to="0"
                                    dur={`${FLARE_MS}ms`}
                                    fill="freeze"
                                  />
                                </circle>
                              )}
                            </Show>
                          </g>
                        </Show>
                      )
                    }}
                  </For>
                </g>
              </g>
              {/* RECALL RANKS, in SCREEN space like the labels and for the same reason — a rank drawn
                inside the zoomed group is illegible at one zoom and a billboard at another.
                🔴 The RANK is the point. "These six came back" is a set; "this one first, then this"
                is what the store actually decided, and it is the only part of ranking a person can
                check against their own sense of what should have been remembered. */}
              <Show when={recall()}>
                {(hit) => (
                  <g data-slot="memory-graph-ranks" class="pointer-events-none">
                    <For each={projected().nodes}>
                      {(node) => {
                        const rank = () => hit().ranks.get(node.id)
                        const at = () => {
                          const p = positions()[node.id]
                          return p ? project(p, view()) : undefined
                        }
                        return (
                          <Show when={rank() !== undefined && at()}>
                            <g
                              data-slot="memory-graph-rank"
                              data-node-id={node.id}
                              data-rank={rank()}
                              transform={`translate(${at()!.x} ${at()!.y})`}
                            >
                              {/* 🔴 THE STAGGER RIDES THE RADIUS, NEVER THE OPACITY. Measured in the
                                Browser pane: an animation that has BEGUN pins its attribute to the
                                first value, and a hidden tab never advances the timeline — so a
                                badge whose visibility depended on `opacity: 0 → 1` stayed at 0
                                forever. Frozen here, the ring is merely a few pixels wide of its
                                resting size. `rankPop` carries the whole reasoning. */}
                              <circle r={RANK_RING_R} fill="none" stroke="#eab308" stroke-width={2} opacity={0.9}>
                                <Show when={motion()}>
                                  <animate
                                    attributeName="r"
                                    values={rankPop(rank()!).values}
                                    keyTimes={rankPop(rank()!).keyTimes}
                                    dur={rankPop(rank()!).dur}
                                    fill="freeze"
                                  />
                                </Show>
                              </circle>
                              <text
                                x={0}
                                y={-14}
                                font-size="10"
                                text-anchor="middle"
                                fill="#eab308"
                                class="select-none"
                              >
                                {rank()}
                              </text>
                            </g>
                          </Show>
                        )
                      }}
                    </For>
                  </g>
                )}
              </Show>
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
                    const dim = () => dimmed(node.id)
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
                      fallback={
                        <span class="rounded bg-v2-background-bg-layer-03 px-1.5 py-0.5 text-xs opacity-60">
                          {language.t("memoryGraph.page.group")}
                        </span>
                      }
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
                        <p class="mb-1 leading-snug" data-slot="memory-inspector-text">
                          {rowOf(sel().id)?.text}
                        </p>
                        {/* WHAT IT IS AND HOW IT GOT HERE — the two things that are always true of a
                          stored memory, on one line each, before anything conditional. */}
                        <div class="mb-2 flex flex-wrap items-center gap-2 text-xs opacity-60">
                          <span>{rowOf(sel().id)?.kind}</span>
                          <span>·</span>
                          <span>{rowOf(sel().id)?.relation}</span>
                          <Show when={statusBadge(rowOf(sel().id)?.status)}>
                            {(badge) => (
                              <span
                                class="rounded px-1.5 py-0.5"
                                data-slot="memory-inspector-status"
                                style={{ background: badge().tint, color: badge().ink }}
                                title={badge().title}
                              >
                                {badge().label}
                              </span>
                            )}
                          </Show>
                        </div>
                        {/* PROVENANCE. `source` is who or what wrote it — auto-extraction, the `kb`
                          tool, an import. It is the first question a person asks of a fact about
                          themselves that they did not type, and the panel used to bury it in a row
                          of dot-separated words. */}
                        <Show when={rowOf(sel().id)?.source}>
                          {(source) => (
                            <p class="mb-1 text-xs opacity-60" data-slot="memory-inspector-source">
                              <span class="opacity-70">{language.t("memoryGraph.page.recordedBy")} </span>
                              {source()}
                            </p>
                          )}
                        </Show>
                        {/* EVIDENCE IS NOT THE CLAIM. A locator the claim was drawn FROM — and when a
                          `needs_review` flag is on the row, this is the thing that moved. Showing
                          them apart is what makes "the citation is stale, the fact is not" a
                          sentence somebody can check rather than one they have to take on faith. */}
                        <Show when={rowOf(sel().id)?.evidence}>
                          {(evidence) => (
                            <p class="mb-1 text-xs opacity-60 break-words" data-slot="memory-inspector-evidence">
                              <span class="opacity-70">
                                {rowOf(sel().id)?.evidenceKind ? `${rowOf(sel().id)!.evidenceKind}: ` : "From: "}
                              </span>
                              {evidence()}
                            </p>
                          )}
                        </Show>
                        {/* IDENTITY — whether this claim can ever be corrected. A claim the harness
                          accepted a `{subject, predicate}` for is one a later answer can retire; one
                          without is a fact that can only be forgotten. That difference is invisible
                          in the text and decides what the user can expect. */}
                        <Show
                          when={rowOf(sel().id)?.predicate}
                          fallback={
                            <Show when={rowOf(sel().id)?.kind === "claim"}>
                              <p class="mb-1 text-xs opacity-50" data-slot="memory-inspector-identity">
                                {language.t("memoryGraph.page.noIdentityNothingCanCorrectThis")}
                              </p>
                            </Show>
                          }
                        >
                          {(predicate) => (
                            <p class="mb-1 text-xs opacity-60" data-slot="memory-inspector-identity">
                              <span class="opacity-70">{language.t("memoryGraph.page.identity")} </span>
                              {rowOf(sel().id)?.subject ?? "?"} · {predicate()}
                            </p>
                          )}
                        </Show>
                        {/* THE TIMELINE — what replaced this, and what it replaced. Both directions,
                          both clickable: a correction you can only read in one direction is half a
                          story. ⚠️ It is built from the ROWS on the canvas, not from a history
                          endpoint, because there is no `/memory/claimHistory` on this instance —
                          the engine has `claimHistory`, the HTTP surface does not expose it. So
                          this shows the links that ARE reachable and claims nothing further. */}
                        <Show when={timeline(sel().id).length > 0}>
                          <div class="mb-3 mt-2" data-slot="memory-inspector-timeline">
                            <div class="text-xs font-medium opacity-70">{language.t("memoryGraph.page.timeline")}</div>
                            <ul class="mt-1 flex flex-col gap-1">
                              <For each={timeline(sel().id)}>
                                {(step) => (
                                  <li class="text-xs">
                                    <Show when={step.id} fallback={<span class="opacity-60">{step.label}</span>}>
                                      {(id) => (
                                        <button class="text-left hover:underline" onClick={() => setSelected(id())}>
                                          <span class="opacity-50">{step.label} </span>
                                          {truncate(markLabel(id()), 28)}
                                        </button>
                                      )}
                                    </Show>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </div>
                        </Show>
                        {/* ARCHIVE / RESTORE — live now that `/api/memory/claim/status` exists.
                          ⚠️ A SUPERSEDED claim is not restorable from here and the control says so
                          rather than offering a button that would answer `false`. Restoring it would
                          put two current answers to one question in the cabinet, which is the state
                          the lifecycle exists to prevent; the way back is to make a new claim. */}
                        {/* WHY IS THIS HERE — the ledger's answer, asked for rather than always shown. */}
                        <div class="mb-3" data-slot="memory-inspector-why">
                          <button
                            type="button"
                            data-slot="memory-inspector-why-toggle"
                            class="text-xs underline opacity-60 hover:opacity-100"
                            onClick={() => setWhyOpen((current) => (current === sel().id ? undefined : sel().id))}
                          >
                            {whyOpen() === sel().id ? "Hide why this is here" : "Why is this here?"}
                          </button>
                          <Show when={whyOpen() === sel().id}>
                            <Show
                              when={why()}
                              fallback={
                                <p class="mt-1 text-[11px] opacity-50">
                                  {language.t("memoryGraph.page.askingTheLedger")}
                                </p>
                              }
                            >
                              {(answer) => (
                                <div class="mt-1 text-[11px] opacity-70">
                                  <Show
                                    when={answer().ok}
                                    fallback={
                                      <p class="opacity-60">
                                        {language.t("memoryGraph.page.thisInstanceCouldNotAnswerIt")}
                                      </p>
                                    }
                                  >
                                    <Show
                                      when={answer().usage}
                                      fallback={
                                        /* ⚠️ Not "never useful". No recall has ever RETURNED it, which is a
                                         different and much weaker statement, and the one the ledger can
                                         actually make. */
                                        <p class="opacity-60">
                                          {language.t("memoryGraph.page.noRecallHasEverReturnedThis")}
                                        </p>
                                      }
                                    >
                                      {(usage) => (
                                        <p>
                                          Returned {usage().accesses}×, reached the model {usage().uses}×
                                          {usage().useful > 0 ? ", vouched for" : ""}
                                          {usage().corrections > 0
                                            ? `, and cost ${usage().corrections} wrong answer${usage().corrections === 1 ? "" : "s"} before it was corrected`
                                            : ""}
                                          .
                                        </p>
                                      )}
                                    </Show>
                                    {/* ⚠️ The QUESTION is a fingerprint and never the words — a recall query
                                      is built from the user's own prompt, and putting it on this panel
                                      would make an open Memory app a copy of the prompt stream. */}
                                    <Show when={answer().accesses.length > 0}>
                                      <ul class="mt-1 flex flex-col gap-0.5">
                                        <For each={answer().accesses.slice(0, 6)}>
                                          {(access) => (
                                            <li class="opacity-60">
                                              {Timestamp.toDate(access.accessedAt)?.toLocaleString() ?? "—"} ·{" "}
                                              {access.surface} · rank {access.rank}
                                              {access.usedAt === null ? " · not shown to the model" : ""}
                                            </li>
                                          )}
                                        </For>
                                      </ul>
                                    </Show>
                                  </Show>
                                </div>
                              )}
                            </Show>
                          </Show>
                        </div>
                        <div class="mb-3 flex items-center gap-2" data-slot="memory-inspector-lifecycle">
                          <Show
                            when={rowOf(sel().id)?.status !== "superseded"}
                            fallback={
                              <span class="text-[11px] opacity-50" data-slot="memory-inspector-superseded">
                                {language.t("memoryGraph.page.replacedByANewerAnswerRecord")}
                              </span>
                            }
                          >
                            <button
                              type="button"
                              data-slot="memory-inspector-archive"
                              disabled={lifecycleBusy() === sel().id}
                              title={rowOf(sel().id)?.status === "archived" ? RESTORE_MEANS : ARCHIVE_MEANS}
                              class="rounded bg-v2-background-bg-layer-03 px-2 py-1 text-xs opacity-80 hover:opacity-100 disabled:opacity-40"
                              onClick={() => void setLifecycle(sel().id)}
                            >
                              {rowOf(sel().id)?.status === "archived" ? "Restore" : "Archive"}
                            </button>
                            <span class="text-[11px] opacity-50">
                              {rowOf(sel().id)?.status === "archived" ? RESTORE_MEANS : ARCHIVE_MEANS}
                            </span>
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
                  <Show
                    when={selectedEdges().length > 0}
                    fallback={<p class="text-xs opacity-40">{language.t("memoryGraph.page.noLinks")}</p>}
                  >
                    <div class="text-xs font-medium opacity-70">{language.t("memoryGraph.page.links")}</div>
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

        {/* The activity rail. Not on Settings — that tab is about switches, and a live feed beside a
          consent toggle is decoration rather than information. */}
        <Show when={appView() !== "settings"}>
          <MemoryActivityFeedRail
            entries={live().entries}
            streamStatus={activity.streamStatus()}
            reconciling={activity.reconciling()}
            reducedMotion={activity.reducedMotion()}
            skipped={live().skipped}
            onSelect={inspect}
          />
        </Show>
      </div>
    </div>
  )
}
