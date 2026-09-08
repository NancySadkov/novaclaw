import { type Component, For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useConfirm } from "@/components/dialog-confirm"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import {
  memoryClearScopeVerified,
  memoryInvalidate,
  memoryList,
  memoryCorrectionProne,
  memoryFeedback,
  memoryProtection,
  memoryNeverUsed,
  memoryStats,
  memoryUseful,
  type MemoryRow,
} from "@/utils/memory-api"
import { instanceDiagnosis } from "@/utils/resource-api"
import { memoryUnavailable } from "@/utils/memory-health"
import { describeScope, isNarrowed, matches, type MemoryFilter } from "@/utils/memory-filter"
import { applyLens, FORGOTTEN_BADGE, forgottenIDs, lensByID, statusBadge } from "@/utils/memory-lens"
import type { MemoryOwner } from "@/apps/memory-owner"
import { createSettledResource } from "@/utils/settled-resource"

/** One shared empty set, so a lens with nothing to mark does not mint a new one per read. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

/**
 * ONE READ of the list, whatever answered it.
 *
 * The three optional fields are the three ways an answer can be less than it looks: some rows were
 * forgotten and the wire cannot say which, the lens has no data source on this instance, or the
 * scan behind it stopped short. Each is carried rather than dropped, because every one of them
 * turns into a confident lie if the surface renders the rows without it.
 */
interface ListPage {
  readonly rows: readonly MemoryRow[]
  readonly forgotten: ReadonlySet<string>
  readonly unanswered?: boolean
  readonly partialScan?: number
}

/**
 * The **Remembered** list — what NovaClaw has learned, in plain sentences.
 *
 * Extracted from the Memory settings tab so the Memory APP can hold it (owner, 2026-08-12: *"all
 * the settings, like `Remembered` list, should be integrated into this Memory app"*). The app is
 * where a person goes to ask "what do you know about me", and the answer was living in a settings
 * panel behind a graph they could not read.
 *
 * ⚠️ It owns its own fetch rather than taking rows as a prop. The two callers refresh on different
 * events — the settings tab after an import or a bulk forget, the app on open — and threading one
 * parent's resource through both would tie each surface's staleness to the other's.
 */
export const MemoryRemembered: Component<{
  /** The chat whose scope reads as "this chat"; absent outside a session. */
  sessionID?: string
  /** Bumped by a caller that has just changed the set, to force a re-read. */
  revision?: number
  /**
   * WHOSE memory to list (AGENTS.md — the structural metaphor). Absent = everything this instance
   * holds, which is what the in-session panel wants; the Memory app passes one colleague's cabinet
   * or the household's shared facts, because "what do you know about me" now has a subject.
   */
  owner?: Pick<MemoryOwner, "scopes" | "label">
  /**
   * The SHARED filter (`utils/memory-filter.ts`). Absent = show everything this list fetched, which is
   * what the in-session panel wants; the Memory app passes the one its header owns, so a query typed
   * once narrows the list and picks out the marks on the Map.
   */
  filter?: MemoryFilter
  /**
   * Report what the filter left visible, so the shared header can show ONE count.
   *
   * ⚠️ Reported UP rather than computed twice. The header cannot see these rows (the list owns its
   * own fetch, deliberately — the two callers refresh on different events), and a second count
   * derived from a second fetch is how two numbers about one cabinet start disagreeing.
   */
  onCounts?: (counts: { visible: number; loaded: number; total: number | undefined }) => void
  /**
   * NEIGHBORHOOD FOCUS: show only these ids. Absent = no focus, which is NOT the same as an empty set
   * — an empty set is a focus whose neighborhood turned out to hold nothing this list can show, and
   * that is a real answer the user is entitled to see rather than a reason to fall back to everything.
   */
  restrictTo?: ReadonlySet<string>
  /** What the focus is OF, in the user's words — the list says whose neighborhood it is showing. */
  restrictLabel?: string
  onClearRestrict?: () => void
  /**
   * Open one memory in the Map's inspector — the surface that can show provenance, evidence,
   * timeline and relationships beside the picture that explains them. Absent = there is no such
   * surface here (the in-session panel has no map), so the control is not offered rather than
   * offered dead.
   */
  onInspect?: (id: string) => void
  class?: string
}> = (props) => {
  const language = useLanguage()
  const confirm = useConfirm()
  const server = useServer()
  const global = useGlobal()
  const serverSync = useServerSync()
  const [localTick, setLocalTick] = createSignal(0)

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const directory = () => serverSync().data.path?.directory ?? ""
  const sessionScope = () => (props.sessionID ? `session:${props.sessionID}` : undefined)

  /**
   * WHICH LIFECYCLE LENS this list reads through (`utils/memory-lens.ts`).
   *
   * ⚠️ An absent filter means `Current`, never "everything". `/memory/list` with no `statuses`
   * returns every status INCLUDING history, so a caller that said nothing would quietly start
   * showing corrected and archived claims beside current ones — the one distinction the claim
   * lifecycle exists to draw.
   */
  const lens = () => lensByID(props.filter?.lens)

  const [memories, { refetch }] = createResource(
    () => {
      const cn = conn()
      return cn
        ? {
            cn,
            dir: directory(),
            scopes: props.owner?.scopes,
            // The lens is IN the key: changing it asks the server a different question, rather
            // than being a different way of hiding the same answer.
            statuses: lens().statuses,
            includeInvalid: lens().includeInvalid,
            source: lens().source,
            t: (props.revision ?? 0) + localTick(),
          }
        : undefined
    },
    async ({ cn, dir, scopes, statuses, includeInvalid, source }): Promise<ListPage> => {
      // ⚠️ Entities and episodes only — NOT passages. "Remembered" answers *what do you know*, and a
      // passage is the raw source text a document was cut into, not something learned. Measured
      // 2026-08-12: ingesting one rulebook put 302 chunks here, so the honest answer to that question
      // became a wall of unreadable fragments. The graph already hides passages by default for the
      // same reason; this keeps the two surfaces telling the same story.
      const query = {
        directory: dir,
        limit: 500,
        // 🔴 CLAIMS BELONG HERE. The claim is the store's first-class unit of memory since P1, and
        // this list asked for entities and episodes only — so the surface whose whole job is
        // answering "what do you remember" showed everything EXCEPT the governed facts.
        kinds: ["entity", "episode", "claim"],
        ...(scopes === undefined ? {} : { scopes }),
        ...(statuses === undefined ? {} : { statuses }),
      }
      // 🔴 `Never used` is a question for the ACCESS LEDGER, not for a status set: "nothing has
      // ever recalled this" is not a property of the claim. It reads its own route, which also
      // reports how deep its scan reached — a short answer is not proof there are no more.
      if (source === "never-used") {
        const answer = await memoryNeverUsed(cn.http, {
          directory: dir,
          ...(scopes === undefined ? {} : { scopes }),
          limit: 500,
        }).catch(() => undefined)
        // ⚠️ `undefined` — not `[]`. An instance without the usage routes has NOT told us that
        // nothing is unused, and rendering an empty list would say exactly that.
        if (!answer) return { rows: [] as MemoryRow[], forgotten: EMPTY_IDS, unanswered: true }
        return {
          rows: answer.items as readonly MemoryRow[],
          forgotten: EMPTY_IDS,
          ...(answer.partial ? { partialScan: answer.scanned } : {}),
        }
      }
      /**
       * 🔴 `Vouched for` and `Keeps being corrected` are the OTHER two ledger questions, and until
       * this branch existed their routes answered correctly and nothing called them. A vouched
       * memory is excluded from the forgetting pass outright, so "which ones are protected" had no
       * surface at all — the protection was reachable and unused, which from a user's side is the
       * same as absent.
       */
      if (source === "useful") {
        const answer = await memoryUseful(cn.http, {
          directory: dir,
          ...(scopes === undefined ? {} : { scopes }),
          limit: 500,
        }).catch(() => undefined)
        if (!answer) return { rows: [] as MemoryRow[], forgotten: EMPTY_IDS, unanswered: true }
        return { rows: answer.items as readonly MemoryRow[], forgotten: EMPTY_IDS }
      }
      if (source === "corrections") {
        const answer = await memoryCorrectionProne(cn.http, { directory: dir, limit: 200 }).catch(() => undefined)
        if (!answer) return { rows: [] as MemoryRow[], forgotten: EMPTY_IDS, unanswered: true }
        // ⚠️ FLATTENED, and the grouping survives as the caption on each row rather than as nesting.
        // The row component is the one place a memory is rendered; a second, nested renderer for one
        // lens would be a second answer to "how does a memory look", free to drift from the first.
        const rows = answer.groups.flatMap((group) => group.items) as readonly MemoryRow[]
        return { rows, forgotten: EMPTY_IDS }
      }
      const rows = await memoryList(cn.http, { ...query, includeInvalid }).catch(() => [] as MemoryRow[])
      // 🔴 THE SECOND READ EXISTS BECAUSE THE WIRE CARRIES NO VALIDITY FIELD. Measured on a live
      // instance: a forgotten row comes back from `includeInvalid` still reading `status: "active"`,
      // so the only way to know which rows those were is to ask the same question again without it
      // and take the difference. It runs ONLY under History — a lens somebody deliberately opened.
      if (!includeInvalid) return { rows, forgotten: EMPTY_IDS }
      const valid = await memoryList(cn.http, query).catch(() => rows)
      return { rows, forgotten: forgottenIDs(rows, valid) }
    },
  )

  /**
   * How many rows exist in TOTAL, so the ones not listed can be counted rather than concealed.
   *
   * ⚠️ Filtering silently would be worse than the wall it replaces: a user who ingested a document
   * would see one entity and have no way to know 302 source passages are held behind it.
   */
  const [totals] = createResource(
    () => {
      const cn = conn()
      const rows = memories()
      return cn !== undefined && rows !== undefined ? { cn, dir: directory(), settled: rows.rows.length } : undefined
    },
    ({ cn, dir }) => memoryStats(cn.http, { directory: dir }).catch(() => undefined),
  )

  const loadedRows = () => memories()?.rows ?? []
  /** Which of the loaded rows were FORGOTTEN — only ever non-empty under History. */
  const forgotten = (): ReadonlySet<string> => memories()?.forgotten ?? EMPTY_IDS
  /**
   * WHAT THE LENS COULD NOT ANSWER, in the user's words — `undefined` when it answered fully.
   *
   * 🔴 `Never used` has no data source on this instance: `memory.recalled` rides the bus LIVE and
   * is never written down, and there is no access ledger to ask. An empty list under that tab would
   * be the empty-cabinet lie in its newest costume — "nothing here is unused" is a confident claim
   * about a measurement nobody has taken. So the tab says so instead. The wiring point is
   * `applyLens` in `utils/memory-lens.ts`: one function, when P3 lands.
   */
  const unmeasured = () =>
    memories()?.unanswered ? applyLens({ ...lens(), measured: false }, loadedRows()).unmeasured : undefined
  /** How far a `Never used` scan reached when it stopped short — `undefined` when it did not. */
  const partialScan = () => memories()?.partialScan
  /** The rows after the shared filter AND the focus — what the user is actually looking at. */
  const visibleRows = createMemo(() => {
    const filter = props.filter
    const only = props.restrictTo
    if (unmeasured()) return [] as MemoryRow[]
    let rows = loadedRows()
    if (only) rows = rows.filter((row) => only.has(row.id))
    if (filter) rows = rows.filter((row) => matches(row, filter))
    return rows
  })
  const count = () => visibleRows().length
  const notListed = () => Math.max(0, (totals()?.total ?? 0) - loadedRows().length)
  /**
   * What the search actually covered, when it covered less than the store holds.
   *
   * "Nothing matches" over a partial load is the empty cabinet in a new costume — true of what was
   * searched, false as an answer to the question that was asked.
   */
  const scopeNote = () =>
    props.filter && isNarrowed(props.filter)
      ? describeScope({ loaded: loadedRows().length, total: totals()?.total })
      : undefined

  createEffect(() => props.onCounts?.({ visible: count(), loaded: loadedRows().length, total: totals()?.total }))

  /**
   * 🔴 Is the store BROKEN, or merely empty?
   *
   * They are indistinguishable from `list` alone — a degraded memory client returns `[]`, exactly
   * like a fresh install. Measured 2026-08-12 by fault injection: with the graph unopenable this
   * panel said *"Nothing remembered yet … no setup needed"*, both halves false, and a user would
   * have chatted for weeks believing NovaClaw was learning. The server-side board is the one place
   * that knows the difference, so ask it.
   *
   * ⚠️ No `probe`, so this contacts nobody and costs no egress — the board is free unless a user
   * deliberately asks it to reach a provider.
   */
  const [health, healthActions] = createResource(
    // ⚠️ Keyed on the LIST having settled, not on the connection. The engine opens lazily, so a
    // board read at mount reports "not opened yet" — `unknown`, not `problem` — and this panel would
    // fall through to the empty state exactly as before the fix. The list is what demands the
    // subsystem; only after it resolves does the board know anything.
    () => {
      const cn = conn()
      const rows = memories()
      return cn !== undefined && rows !== undefined ? { cn, settled: rows.rows.length } : undefined
    },
    ({ cn }) => instanceDiagnosis(cn.http).catch(() => undefined),
  )
  // ⚠️ The SHARED predicate (`utils/memory-health.ts`), not a local copy. The Graph tab asks the same
  // question, and two surfaces of one cabinet disagreeing about whether it is broken is exactly the
  // fault this component was written to stop showing.
  const unavailable = () => memoryUnavailable(health())

  const [retrying, setRetrying] = createSignal(false)
  const retry = async () => {
    setRetrying(true)
    try {
      // Demand the subsystem again: `list` goes through the capability, so a successful open flips
      // the board's signal on the next read. One user-visible action, two refreshes.
      await refetch()
      await healthActions.refetch()
    } finally {
      setRetrying(false)
    }
  }

  /** Whose memory this is, in the user's terms — never the raw `session:<id>` scope string. */
  const scopeLabel = (scope: string): string => {
    if (scope === sessionScope()) return language.t("settings.memory.scope.chat")
    if (scope === "global") return language.t("settings.memory.scope.global")
    if (scope.startsWith("session:")) return language.t("settings.memory.scope.otherChat")
    return language.t("settings.memory.scope.global")
  }

  // Reads and batch writes derive their scope from the same owner. A label and an unrelated
  // hard-coded scope let a colleague's Clear control erase the household's shared memories.
  const clearTargets = createMemo(() =>
    props.owner
      ? props.owner.scopes.map((scope) => ({ scope, label: props.owner!.label }))
      : [
          { scope: "global", label: language.t("memory.clearScope.shared") },
          ...(sessionScope() ? [{ scope: sessionScope()!, label: language.t("settings.memory.scope.chat") }] : []),
        ],
  )
  const forgetScope = async (target: { scope: string; label: string }) => {
    const cn = conn()
    if (!cn) return
    const proceed = await confirm({
      title: language.t("memory.clearScope.title", { owner: target.label }),
      description: language.t("memory.clearScope.description", { owner: target.label }),
      confirmLabel: language.t("memory.forgetAll.confirm.action"),
      destructive: true,
    })
    if (!proceed) return
    try {
      await memoryClearScopeVerified(cn.http, { directory: directory(), scope: target.scope })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.memory.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
      return
    }
    setLocalTick((value) => value + 1)
    void refetch()
  }

  // Protection is durable state. One complete batch answers for these rows; absence in a capped
  // useful-memory list cannot establish that a memory is unprotected.
  const [protection, protectionActions] = createSettledResource(
    () => {
      const cn = conn()
      return cn ? { cn, directory: directory(), ids: loadedRows().map((row) => row.id) } : undefined
    },
    ({ cn, ...input }) => memoryProtection(cn.http, input),
  )
  const protectedState = (id: string) => (protection.state === "ready" ? protection()?.get(id) : undefined)
  const [savingProtection, setSavingProtection] = createSignal<ReadonlySet<string>>(EMPTY_IDS)
  const vouch = async (row: MemoryRow) => {
    const cn = conn()
    const current = protectedState(row.id)
    if (!cn || current === undefined || savingProtection().has(row.id)) return
    const next = !current
    const dir = directory()
    setSavingProtection((ids) => new Set([...ids, row.id]))
    try {
      if (!(await memoryFeedback(cn.http, { directory: dir, id: row.id, useful: next })))
        throw new Error("Memory protection was not saved")
      const saved = await memoryProtection(cn.http, { directory: dir, ids: [row.id] })
      if (saved.get(row.id) !== next) throw new Error("Memory protection was not saved")
      // The `Vouched for` lens reads the ledger, so it has to be re-asked rather than patched.
      setLocalTick((value) => value + 1)
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save that",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await protectionActions.refetch()
      setSavingProtection((ids) => new Set([...ids].filter((id) => id !== row.id)))
    }
  }

  const forget = async (row: MemoryRow) => {
    const cn = conn()
    if (!cn) return
    // ⚠️ The confirm is what REPLACES the expertise gate this control used to sit behind, and it is
    // the honest trade: hiding an irreversible action from most people does not make it safer, it
    // makes the fault unfixable for them. A question anyone can answer does.
    const proceed = await confirm({
      title: language.t("memory.forget.confirm.title"),
      description: row.text,
      confirmLabel: language.t("settings.memory.forget.action"),
      destructive: true,
    })
    if (!proceed) return
    await memoryInvalidate(cn.http, { directory: directory(), id: row.id }).catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t("settings.memory.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      }),
    )
    setLocalTick((value) => value + 1)
    void refetch()
  }

  return (
    <div class={props.class} data-component="memory-remembered">
      <div class="flex items-center justify-between gap-2">
        <div class="settings-v2-section-title">
          {count() > 0
            ? language.t("settings.memory.list.title", { count: count() })
            : language.t("settings.memory.list.titleEmpty")}
        </div>
        {/* Batch removal, where the rows are. Hidden when there is nothing to clear, so the app does
            not offer a destructive action against an empty set. */}
        <Show when={count() > 0}>
          <div class="flex shrink-0 gap-1.5" data-slot="memory-batch">
            <For each={clearTargets()}>
              {(target) => (
                <ButtonV2 size="small" variant="ghost-muted" onClick={() => void forgetScope(target)}>
                  {language.t("memory.clearScope.action", { owner: target.label })}
                </ButtonV2>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show
        when={!unavailable()}
        fallback={
          <div class="flex flex-col items-start gap-2" data-slot="memory-unavailable">
            <p class="settings-v2-field-description">
              <strong>{language.t("settings.memory.unavailable.title")}</strong>
              <br />
              {language.t("settings.memory.unavailable.body")}
            </p>
            <ButtonV2 size="small" variant="outline" disabled={retrying()} onClick={() => void retry()}>
              {retrying()
                ? language.t("settings.memory.unavailable.retrying")
                : language.t("settings.memory.unavailable.retry")}
            </ButtonV2>
          </div>
        }
      >
        <Show
          when={count() > 0}
          fallback={
            // ⚠️ Two different emptinesses. "Nothing remembered" is a fact about the cabinet; "nothing
            // matches" is a fact about the query, and saying the first when the second is true tells a
            // user their memories are gone.
            <div class="flex flex-col gap-1" data-slot="memory-list-empty">
              {/* THREE emptinesses, and telling them apart is the whole point. The cabinet is empty; the
                query matched nothing; the focused neighborhood holds nothing this list shows. Saying
                the first when either of the others is true tells someone their memories are gone. */}
              {/* FOUR emptinesses now, and the fourth is not an emptiness at all: the lens has no
                data source yet, so "nothing here" would be a claim about a measurement nobody took.
                It outranks the others — a question that CANNOT be answered is not one that was
                answered "none". */}
              <Show
                when={unmeasured()}
                fallback={
                  <p class="settings-v2-field-description">
                    {props.restrictLabel
                      ? `Nothing else here connects to ${props.restrictLabel}.`
                      : loadedRows().length > 0
                        ? "No memory here matches that search."
                        : language.t("settings.memory.list.empty")}
                  </p>
                }
              >
                {(note) => (
                  <p class="settings-v2-field-description" data-slot="memory-lens-unmeasured">
                    {note()}
                  </p>
                )}
              </Show>
              <Show when={props.restrictLabel}>
                <button
                  type="button"
                  data-slot="memory-focus-clear-empty"
                  class="self-start text-xs underline opacity-70 hover:opacity-100"
                  onClick={props.onClearRestrict}
                >
                  Show everything
                </button>
              </Show>
              <Show when={scopeNote()}>
                {(note) => (
                  <p class="settings-v2-field-description" data-slot="memory-search-scope">
                    {note()}
                  </p>
                )}
              </Show>
            </div>
          }
        >
          <Show when={notListed() > 0}>
            <p class="settings-v2-field-description" data-slot="memory-passages-hidden">
              {language.t("settings.memory.list.sourceHidden", { count: notListed() })}
            </p>
          </Show>
          <Show when={scopeNote()}>
            {(note) => (
              <p class="settings-v2-field-description" data-slot="memory-search-scope">
                {note()}
              </p>
            )}
          </Show>
          {/* ⚠️ A SHORT ANSWER IS NOT PROOF THERE ARE NO MORE. The never-used scan stops at a depth
            the server chooses, and without this line a list of three would read as "only three
            memories have never been used" — which is the slice-presented-as-the-whole failure the
            Map already learned to report. */}
          <Show when={partialScan()}>
            {(scanned) => (
              <p class="settings-v2-field-description" data-slot="memory-usage-partial">
                Looked at the {scanned()} oldest, not the whole cabinet.
              </p>
            )}
          </Show>
          <Show when={props.restrictLabel}>
            {(label) => (
              <p class="settings-v2-field-description" data-slot="memory-focus-note">
                Showing what connects to <strong>{label()}</strong>.{" "}
                <button type="button" class="underline opacity-70 hover:opacity-100" onClick={props.onClearRestrict}>
                  Show everything
                </button>
              </p>
            )}
          </Show>
          <div class="flex flex-col gap-1.5 overflow-y-auto pr-1">
            <For each={visibleRows()}>
              {(row) => (
                <div
                  class="flex items-start justify-between gap-3 rounded-md border border-[var(--nc-border-subtle,rgba(255,255,255,0.08))] px-3 py-2"
                  data-slot="memory-row"
                  data-memory-id={row.id}
                  data-status={row.status}
                >
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-sm leading-snug break-words">{row.text}</span>
                    <span class="flex flex-wrap items-center gap-1.5 text-xs opacity-60">
                      <span>{scopeLabel(row.scope)}</span>
                      {/* 🔴 The badge appears only when the status is NOT the ordinary one. A tag on
                        every row saying "active" trains the eye to skip exactly the place the one
                        meaningful word will appear. ⚠️ FORGOTTEN is not a status — it is a closed
                        validity range the wire does not carry — so it arrives as a set of ids and
                        falls through to the same badge. */}
                      <Show when={statusBadge(row.status) ?? (forgotten().has(row.id) ? FORGOTTEN_BADGE : undefined)}>
                        {(badge) => (
                          <span
                            class="rounded px-1.5 py-0.5"
                            data-slot="memory-row-status"
                            style={{ background: badge().tint, color: badge().ink }}
                            title={badge().title}
                          >
                            {badge().label}
                          </span>
                        )}
                      </Show>
                      <Show when={props.onInspect}>
                        <button
                          type="button"
                          data-slot="memory-row-inspect"
                          class="underline opacity-70 hover:opacity-100"
                          onClick={() => props.onInspect?.(row.id)}
                        >
                          Show on the map
                        </button>
                      </Show>
                      {/* 🔴 THE VOUCH — the only door to the pruning protection.
                        `POST /api/memory/feedback` shipped with no caller, so a memory could be
                        protected from the forgetting pass and nobody had any way to protect one. It
                        sits beside Forget deliberately: the two are the same question asked in
                        opposite directions, and a person deciding "is this worth keeping" wants both
                        answers in one place.
                        ⚠️ The label says what it DOES, not what it is. "Useful" is a judgement; "Keep
                        this" is the consequence, which is the thing a user is actually choosing. */}
                      <button
                        type="button"
                        data-slot="memory-row-vouch"
                        data-vouched={protectedState(row.id) ? "" : undefined}
                        aria-pressed={protectedState(row.id)}
                        disabled={
                          savingProtection().has(row.id) || (!protection.failed && protectedState(row.id) === undefined)
                        }
                        class="underline opacity-70 hover:opacity-100"
                        title={
                          protectedState(row.id)
                            ? "Stop protecting this from the forgetting pass."
                            : "Never forget this one, however rarely it comes up."
                        }
                        onClick={() => (protection.failed ? void protectionActions.refetch() : void vouch(row))}
                      >
                        {protection.failed
                          ? language.t("memory.protection.retry")
                          : savingProtection().has(row.id)
                            ? language.t("memory.protection.saving")
                            : protectedState(row.id) === undefined
                              ? language.t("memory.protection.loading")
                              : protectedState(row.id)
                                ? "Kept ✓"
                                : "Keep this"}
                      </button>
                    </span>
                  </div>
                  {/* 🔴 **Forgetting was ADVANCED, and that is why the owner reported the Memory app
                    had "no way to remove memories" (2026-08-20) — the button was there and their
                    level hid it.** The old note said reading is for everyone while deleting is "the
                    irreversible half" and keeps its guard. That reasoning does not survive contact
                    with what this list holds: these are facts about the PERSON READING, and an
                    expertise gate on removing your own memory is exactly the shape principle 12
                    rejects — the same argument that put Memory itself at Normal (`builtins.tsx`).
                    A gate here also fails the product's own promise: a user who sees something
                    wrong about themselves and cannot remove it has been handed a fault they cannot
                    fix. The irreversibility is answered by the CONFIRM below, which is a question
                    anyone can answer, not by hiding the control from most people. */}
                  <ButtonV2
                    size="small"
                    variant="ghost-muted"
                    icon="close-small"
                    aria-label={language.t("settings.memory.forget.action")}
                    title={language.t("settings.memory.forget.action")}
                    onClick={() => void forget(row)}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
