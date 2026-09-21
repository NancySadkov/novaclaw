import { A, useSearchParams } from "@solidjs/router"
import { Icon } from "@novaclaw/ui/v2/icon"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useConfirm } from "@/components/dialog-confirm"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import {
  memoryProtection,
  memoryUsageDetail,
  worldMemoryCaptions,
  worldMemoryClaimStatus,
  worldMemoryFeedback,
  worldMemoryGraph,
  worldMemoryInvalidate,
  type MemoryGraph,
  type MemoryRow,
  type AtlasCaptions,
} from "@/utils/memory-api"
import { instanceDiagnosis } from "@/utils/resource-api"
import { worldMemoryFaultDetail, worldMemoryUnavailable } from "@/utils/memory-health"
import { showToast } from "@/utils/toast"
import { createSettledResource } from "@/utils/settled-resource"
import { instanceGlobalDirectory } from "@/utils/routing-directory"
import { agentConfigureRoute, agentIDFromOwnerKey, ownerFromKey, ownersFor } from "@/apps/memory-owner"
import type { AgentLike } from "@/apps/contacts"
import { graphFault, type GraphFault } from "./memory-graph/fault"
import { MemorySpaceCanvas, type MemorySpaceControls } from "./memory-space/canvas"
import { buildMemorySpace, cssColor, detailLabel, type DetailLevel } from "./memory-space/model"

const GRAPH_LIMIT = 5000
const INDEX_LIMIT = 120

const short = (text: string, length = 82): string =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text

const rowTitle = (row: MemoryRow): string => row.name?.trim() || short(row.text, 58) || row.kind

const scopeLabel = (scope: string): string => {
  if (scope.startsWith("agent:")) return "This officer's cabinet"
  if (scope.startsWith("session:")) return "One chat"
  return scope
}

const searchable = (row: MemoryRow): string =>
  `${row.name ?? ""}\n${row.text}\n${row.source ?? ""}\n${row.kind}`.toLocaleLowerCase()

/** One honest, officer-owned filing cabinet. Zoom controls density; no stored kind is hidden by default. */
export function MemoryGraphPage() {
  const global = useGlobal()
  const server = useServer()
  const confirm = useConfirm()
  const [params] = useSearchParams<{ owner?: string }>()
  const [revision, setRevision] = createSignal(0)
  const [transportFault, setTransportFault] = createSignal<GraphFault | undefined>()
  const [query, setQuery] = createSignal("")
  const [hiddenKinds, setHiddenKinds] = createSignal<ReadonlySet<string>>(new Set())
  const [selectedID, setSelectedID] = createSignal<string | undefined>()
  const [indexOpen, setIndexOpen] = createSignal(false)
  const [level, setLevel] = createSignal<DetailLevel>("atlas")
  const [busy, setBusy] = createSignal<string | undefined>()
  const [focusedCluster, setFocusedCluster] = createSignal<number | undefined>()
  let controls: MemorySpaceControls | undefined

  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const context = createMemo(() => {
    const current = connection()
    return current ? global.ensureServerCtx(current) : undefined
  })
  const directory = () => instanceGlobalDirectory(context()?.sync.data.path)
  const agents = () => context()?.agents.list()
  const owners = createMemo(() => ownersFor(agents() ?? ([] as AgentLike[])))
  const owner = createMemo(() => ownerFromKey(owners(), params.owner))
  const backRoute = () => {
    const current = owner()
    const agentID = current?.kind === "agent" ? agentIDFromOwnerKey(current.key) : undefined
    return agentID ? agentConfigureRoute(agentID) : "/contacts"
  }

  const [graph, graphActions] = createSettledResource(
    () => {
      const current = connection()
      const scopes = owner()?.scopes
      const dir = directory()
      return current && scopes && dir ? { current, scopes, dir, revision: revision() } : undefined
    },
    async ({ current, scopes, dir }): Promise<MemoryGraph> => {
      try {
        const answer = await worldMemoryGraph(current.http, { directory: dir, scopes, limit: GRAPH_LIMIT })
        setTransportFault(undefined)
        return answer
      } catch (error) {
        setTransportFault(graphFault(error))
        throw error
      }
    },
  )

  const [health, healthActions] = createSettledResource(
    () => {
      const current = connection()
      return current && graph.state === "ready" ? current : undefined
    },
    (current) => instanceDiagnosis(current.http),
  )

  const rows = () => graph()?.nodes ?? []
  const edges = () => graph()?.edges ?? []
  const kinds = createMemo(() => [...new Set(rows().map((row) => row.kind))].sort())
  const visibleKinds = createMemo(() => new Set(kinds().filter((kind) => !hiddenKinds().has(kind))))
  const space = createMemo(() => buildMemorySpace(rows(), edges()))

  const captionRequest = (clusterIndexes: readonly number[], memoryLimit: number) => {
    const current = connection()
    const scope = owner()?.scopes[0]
    const dir = directory()
    if (!current || !scope || !dir || owner()?.scopes.length !== 1) return undefined
    const selectedClusters = clusterIndexes.flatMap((index) => {
      const cluster = space().clusters[index]
      return cluster
        ? [{ id: cluster.id, ids: cluster.members.slice(0, 8).map((member) => space().points[member]!.id) }]
        : []
    })
    if (selectedClusters.length === 0) return undefined
    const memories = clusterIndexes
      .flatMap((index) => space().clusters[index]?.members.slice(0, 4) ?? [])
      .slice(0, memoryLimit)
      .map((member) => space().points[member]!.id)
    return { current, scope, dir, clusters: selectedClusters, memories }
  }

  const [atlasCaptions] = createSettledResource(
    () =>
      graph.state === "ready"
        ? captionRequest(
            space()
              .clusters.map((cluster, index) => ({ count: cluster.members.length, index }))
              .sort((left, right) => right.count - left.count)
              .slice(0, 18)
              .map((cluster) => cluster.index),
            48,
          )
        : undefined,
    ({ current, scope, dir, clusters, memories }) =>
      worldMemoryCaptions(current.http, { directory: dir, scope, clusters, memories }),
  )

  const [focusCaptions] = createSettledResource(
    () => {
      const index = focusedCluster()
      if (graph.state !== "ready" || index === undefined) return undefined
      const request = captionRequest([index], 0)
      const cluster = space().clusters[index]
      return request && cluster
        ? {
            ...request,
            memories: cluster.members.slice(0, 48).map((member) => space().points[member]!.id),
          }
        : undefined
    },
    ({ current, scope, dir, clusters, memories }) =>
      worldMemoryCaptions(current.http, { directory: dir, scope, clusters, memories }),
  )

  const combinedCaptions = createMemo(() => {
    const cluster = new Map<string, string>()
    const memory = new Map<string, string>()
    const merge = (answer: AtlasCaptions | undefined) => {
      answer?.clusters.forEach((item) => cluster.set(item.id, item.label))
      answer?.memories.forEach((item) => memory.set(item.id, item.label))
    }
    merge(atlasCaptions())
    merge(focusCaptions())
    return { cluster, memory }
  })

  const captionFallback = createMemo(() => {
    const answers = [atlasCaptions(), focusCaptions()].filter(Boolean) as AtlasCaptions[]
    if (atlasCaptions.failed || focusCaptions.failed || answers.some((answer) => answer.status === "unavailable"))
      return "Caption model unavailable · showing stored labels and excerpts"
    if (answers.some((answer) => answer.status === "partial")) return "Some labels use memory excerpts"
    return undefined
  })
  const selected = createMemo(() => rows().find((row) => row.id === selectedID()))
  const terms = createMemo(() => query().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))
  const matches = createMemo<ReadonlySet<string>>(() => {
    if (terms().length === 0) return new Set<string>()
    return new Set(
      rows()
        .filter((row) => visibleKinds().has(row.kind) && terms().every((term) => searchable(row).includes(term)))
        .map((row) => row.id),
    )
  })
  const indexedRows = createMemo(() => {
    const filtered = rows().filter((row) => visibleKinds().has(row.kind))
    return terms().length === 0 ? filtered : filtered.filter((row) => matches().has(row.id))
  })
  const visibleCount = createMemo(() => rows().filter((row) => visibleKinds().has(row.kind)).length)

  createEffect(() => {
    if (selectedID() && !selected()) setSelectedID(undefined)
  })

  const unavailable = createMemo<GraphFault | undefined>(() => {
    if (graph.failed) return transportFault() ?? { reason: "The memory engine did not answer.", retryable: true }
    if (rows().length > 0) return undefined
    if (worldMemoryUnavailable(health()))
      return {
        reason: worldMemoryFaultDetail(health()) ?? "The memory engine is not running on this instance.",
        retryable: true,
      }
    if (graph.state === "ready" && health.failed)
      return { reason: "NovaClaw could not verify whether this cabinet is empty.", retryable: true }
    return undefined
  })

  const state = createMemo<"loading" | "unavailable" | "empty" | "ready">(() => {
    if (graph.state === "idle" || graph.loading) return rows().length > 0 ? "ready" : "loading"
    if (unavailable()) return "unavailable"
    if (rows().length === 0 && (health.loading || health.state === "idle")) return "loading"
    return rows().length === 0 ? "empty" : "ready"
  })

  const retry = () => {
    void graphActions.refetch()
    void healthActions.refetch()
  }
  const toggleKind = (kind: string) =>
    setHiddenKinds((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  const choose = (id: string | undefined) => {
    setSelectedID(id)
    if (id) setIndexOpen(true)
  }
  const chooseFromIndex = (row: MemoryRow) => {
    choose(row.id)
    controls?.focus(row.id)
  }

  const [protection, protectionActions] = createSettledResource(
    () => {
      const current = connection()
      const id = selectedID()
      const dir = directory()
      return current && id && dir ? { current, id, dir } : undefined
    },
    ({ current, id, dir }) => memoryProtection(current.http, { directory: dir, ids: [id] }),
  )
  const protectedNow = () => {
    const id = selectedID()
    return id && protection.state === "ready" ? protection()?.get(id) : undefined
  }

  const [usage] = createSettledResource(
    () => {
      const current = connection()
      const id = selectedID()
      const dir = directory()
      return current && id && dir ? { current, id, dir } : undefined
    },
    ({ current, id, dir }) => memoryUsageDetail(current.http, { directory: dir, id }),
  )

  const saveProtection = async () => {
    const current = connection()
    const row = selected()
    const prior = protectedNow()
    if (!current || !row || prior === undefined) return
    setBusy("protect")
    try {
      if (!(await worldMemoryFeedback(current.http, { directory: directory(), id: row.id, useful: !prior })))
        throw new Error("The memory was no longer available.")
      await protectionActions.refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save that",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(undefined)
    }
  }

  const archive = async () => {
    const current = connection()
    const row = selected()
    if (!current || !row || row.kind !== "claim") return
    const next = row.status === "archived" ? "active" : "archived"
    setBusy("archive")
    try {
      if (!(await worldMemoryClaimStatus(current.http, { directory: directory(), id: row.id, status: next })))
        throw new Error("That claim is already in that state, or is no longer available.")
      setRevision((value) => value + 1)
    } catch (error) {
      showToast({
        variant: "error",
        title: next === "archived" ? "Could not archive" : "Could not restore",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(undefined)
    }
  }

  const forget = async () => {
    const current = connection()
    const row = selected()
    if (!current || !row) return
    if (
      !(await confirm({
        title: "Forget this memory?",
        description: row.text,
        confirmLabel: "Forget",
        destructive: true,
      }))
    )
      return
    setBusy("forget")
    try {
      if (!(await worldMemoryInvalidate(current.http, { directory: directory(), id: row.id })))
        throw new Error("The memory was already gone.")
      choose(undefined)
      setRevision((value) => value + 1)
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not forget that",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <main class="memory-space-page" data-slot="memory-space" data-state={state()}>
      <header class="memory-space-header">
        <A
          href={backRoute()}
          class="memory-space-icon-button"
          data-slot="memory-back"
          aria-label="Back to officer settings"
        >
          <Icon name="arrow-left" size="large" />
        </A>
        <div class="memory-space-heading">
          <span class="memory-space-kicker">Memory atlas</span>
          <h1 data-slot="memory-title">{owner()?.label ?? "Memory"}</h1>
        </div>
        <div class="memory-space-readout" aria-live="polite">
          <strong>{rows().length.toLocaleString()}</strong>
          <span>{rows().length === 1 ? "memory" : "memories"}</span>
          <Show when={graph()?.slice?.partial}>
            <small data-slot="memory-graph-slice">of {graph()?.slice?.total.toLocaleString()}</small>
          </Show>
        </div>
        <label class="memory-space-search" data-slot="memory-search">
          <span class="sr-only">Search memories</span>
          <input
            type="search"
            value={query()}
            placeholder="Find a memory…"
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              if (event.currentTarget.value.trim()) setIndexOpen(true)
            }}
          />
          <Show when={terms().length > 0}>
            <span data-slot="memory-search-count">{matches().size}</span>
          </Show>
        </label>
        <div class="memory-space-header-actions">
          <button
            class="memory-space-icon-button"
            type="button"
            title="Refresh"
            onClick={() => setRevision((value) => value + 1)}
          >
            <Icon name="reset" size="large" />
          </button>
          <button
            class="memory-space-index-button"
            type="button"
            aria-expanded={indexOpen()}
            onClick={() => setIndexOpen((open) => !open)}
          >
            {indexOpen() ? "Close index" : "Open index"}
          </button>
        </div>
      </header>

      <Show when={state() === "ready"}>
        <section class="memory-space-body">
          <MemorySpaceCanvas
            space={space()}
            selected={selectedID()}
            matches={matches()}
            visibleKinds={visibleKinds()}
            clusterCaptions={combinedCaptions().cluster}
            memoryCaptions={combinedCaptions().memory}
            onSelect={choose}
            onCluster={setFocusedCluster}
            onLevel={setLevel}
            onReady={(value) => (controls = value)}
          />
          <Show when={captionFallback()}>
            {(message) => (
              <div class="memory-space-caption-status" data-slot="memory-caption-status">
                {message()}
              </div>
            )}
          </Show>
          <div class="memory-space-hud memory-space-hud-left">
            <div class="memory-space-level" data-slot="memory-detail-level" data-level={level()}>
              <span>{detailLabel(level())}</span>
              <small>
                {level() === "atlas"
                  ? "Regions and scale"
                  : level() === "systems"
                    ? "Individual stars"
                    : "Names and connections"}
              </small>
            </div>
            <div class="memory-space-zoom" aria-label="Map zoom">
              <button type="button" aria-label="Zoom in" onClick={() => controls?.zoomIn()}>
                +
              </button>
              <button type="button" aria-label="Zoom out" onClick={() => controls?.zoomOut()}>
                −
              </button>
              <button type="button" aria-label="Reset view" onClick={() => controls?.reset()}>
                <Icon name="expand" size="normal" />
              </button>
            </div>
          </div>
          <div class="memory-space-hud memory-space-kind-rail" aria-label="Memory types">
            <For each={kinds()}>
              {(kind) => {
                const count = () => rows().filter((row) => row.kind === kind).length
                const on = () => visibleKinds().has(kind)
                const color = () => space().points.find((point) => point.row.kind === kind)?.color ?? [0.73, 0.66, 0.75]
                return (
                  <button
                    type="button"
                    aria-pressed={on()}
                    data-kind={kind}
                    classList={{ "memory-space-kind-off": !on() }}
                    onClick={() => toggleKind(kind)}
                  >
                    <i style={{ background: cssColor(color()) }} />
                    <span>{kind}</span>
                    <small>{count()}</small>
                  </button>
                )
              }}
            </For>
          </div>

          <Show when={indexOpen() || selected()}>
            <aside class="memory-space-drawer" data-slot="memory-index">
              <div class="memory-space-drawer-handle" aria-hidden="true" />
              <Show
                when={selected()}
                fallback={
                  <>
                    <div class="memory-space-drawer-head">
                      <div>
                        <span class="memory-space-kicker">Index</span>
                        <h2>{terms().length > 0 ? `${indexedRows().length} found` : `${visibleCount()} visible`}</h2>
                      </div>
                      <button
                        type="button"
                        class="memory-space-close"
                        aria-label="Close index"
                        onClick={() => setIndexOpen(false)}
                      >
                        <Icon name="close" size="normal" />
                      </button>
                    </div>
                    <div class="memory-space-index-list">
                      <For each={indexedRows().slice(0, INDEX_LIMIT)}>
                        {(row) => (
                          <button type="button" data-memory-id={row.id} onClick={() => chooseFromIndex(row)}>
                            <i
                              style={{
                                background: cssColor(
                                  space().points.find((point) => point.id === row.id)?.color ?? [0.73, 0.66, 0.75],
                                ),
                              }}
                            />
                            <span>
                              <strong>{rowTitle(row)}</strong>
                              <small>{short(row.text)}</small>
                            </span>
                            <em>{row.kind}</em>
                          </button>
                        )}
                      </For>
                    </div>
                    <Show when={indexedRows().length > INDEX_LIMIT}>
                      <p class="memory-space-index-note">
                        Showing the first {INDEX_LIMIT} of {indexedRows().length}. Narrow the search to go deeper.
                      </p>
                    </Show>
                    <Show when={indexedRows().length === 0}>
                      <div class="memory-space-index-empty">No loaded memory matches this view.</div>
                    </Show>
                  </>
                }
              >
                {(row) => (
                  <div class="memory-space-detail" data-slot="memory-graph-detail">
                    <div class="memory-space-drawer-head">
                      <button type="button" class="memory-space-detail-back" onClick={() => setSelectedID(undefined)}>
                        <Icon name="chevron-left" size="normal" /> Index
                      </button>
                      <button
                        type="button"
                        class="memory-space-close"
                        aria-label="Close detail"
                        onClick={() => {
                          setSelectedID(undefined)
                          setIndexOpen(false)
                        }}
                      >
                        <Icon name="close" size="normal" />
                      </button>
                    </div>
                    <div class="memory-space-detail-orbit" aria-hidden="true">
                      <i
                        style={{
                          background: cssColor(
                            space().points.find((point) => point.id === row().id)?.color ?? [0.73, 0.66, 0.75],
                          ),
                        }}
                      />
                    </div>
                    <span class="memory-space-kicker">
                      {row().kind} · {row().status}
                    </span>
                    <h2>{rowTitle(row())}</h2>
                    <p class="memory-space-detail-text">{row().text}</p>
                    <dl>
                      <div>
                        <dt>Lives in</dt>
                        <dd>{scopeLabel(row().scope)}</dd>
                      </div>
                      <Show when={row().source}>
                        <div>
                          <dt>Learned from</dt>
                          <dd>{row().source}</dd>
                        </div>
                      </Show>
                      <Show when={row().confidence !== null}>
                        <div>
                          <dt>Confidence</dt>
                          <dd>{Math.round((row().confidence ?? 0) * 100)}%</dd>
                        </div>
                      </Show>
                      <div>
                        <dt>Connections</dt>
                        <dd>{space().points.find((point) => point.id === row().id)?.degree ?? 0}</dd>
                      </div>
                      <Show when={usage.state === "ready"}>
                        <div>
                          <dt>Recalled</dt>
                          <dd>{usage()?.usage?.accesses ?? 0} times</dd>
                        </div>
                      </Show>
                    </dl>
                    <Show when={usage.failed}>
                      <p class="memory-space-detail-note">Recall history is unavailable right now.</p>
                    </Show>
                    <div class="memory-space-detail-actions">
                      <button
                        type="button"
                        disabled={protectedNow() === undefined || busy() !== undefined}
                        onClick={() => void saveProtection()}
                      >
                        {protectedNow() ? "Stop keeping" : "Keep this"}
                      </button>
                      <Show when={row().kind === "claim"}>
                        <button type="button" disabled={busy() !== undefined} onClick={() => void archive()}>
                          {row().status === "archived" ? "Restore" : "Archive"}
                        </button>
                      </Show>
                      <button
                        class="memory-space-forget"
                        type="button"
                        disabled={busy() !== undefined}
                        onClick={() => void forget()}
                      >
                        Forget
                      </button>
                    </div>
                  </div>
                )}
              </Show>
            </aside>
          </Show>
        </section>
      </Show>

      <Show when={state() !== "ready"}>
        <section class="memory-space-state" data-slot="memory-graph-state" data-state={state()}>
          <div class="memory-space-state-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <Show when={state() === "loading"}>
            <h2>Opening this cabinet…</h2>
            <p>Mapping memories and their connections.</p>
          </Show>
          <Show when={state() === "empty"}>
            <h2>Nothing remembered yet</h2>
            <p>This space fills as {owner()?.label ?? "the officer"} learns.</p>
          </Show>
          <Show when={state() === "unavailable" ? unavailable() : undefined}>
            {(fault) => (
              <>
                <h2>Memory is unavailable right now</h2>
                <p>{fault().reason}</p>
                <Show when={fault().retryable}>
                  <button type="button" data-slot="memory-graph-retry" onClick={retry}>
                    Try again
                  </button>
                </Show>
              </>
            )}
          </Show>
        </section>
      </Show>
    </main>
  )
}
