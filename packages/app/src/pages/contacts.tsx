import { A, useNavigate } from "@solidjs/router"
import { Dynamic } from "solid-js/web"
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { AppPage } from "@/components/app-page"
import { agentColor } from "@/utils/agent"
import { hiddenRoster, roster, searchRoster, type ContactView } from "@/apps/contacts"
import { SHARED_ROUTE } from "@/apps/memory-owner"
import { listSessions, listUsage, startChat } from "@/apps/agent-list"
import { planHire } from "@/apps/agent-hire"
import { cloneAgent, isNovaCloneRefusal } from "@/apps/agent-clone"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { describeFailure } from "@/utils/failure-copy"
import {
  formatRate,
  liveFor,
  ratePerMinute,
  rosterState,
  rosterTask,
  threadRate,
  type RosterLive,
  type SessionLike,
  type UsageMinute,
  workersOf,
} from "@/apps/roster-live"
import { messageTime } from "@novaclaw/session-ui/v2/message-time"
import { compactTokens } from "@/pages/home-session-meta"
import { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { AgentConfigDialog } from "@/components/agent-config-dialog"
import { AgentPortrait } from "@/components/agent-portrait"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import { sessionExecutions, type SessionExecutionInfo } from "@/utils/session-execution-api"
import { formatTokensPerSecond } from "@/utils/token-rate"

// The Contacts app — the roster of colleagues this instance employs (AGENTS.md → *the structural
// metaphor*; `notes/named-agents.md`).
//
// This replaces "a list of chats that only grows" with "the people you work with", and the swap is
// the point: a session list is a machine's view of history, while a roster is a person's view of an
// organization. Nova (the CEO) is the first row and cannot be retired; every other row is a colleague
// the user hired and may re-brief or retire.
//
// ⚠️ Two rules run through this page and must survive any edit:
//   1. **Memory is disclosed in BOTH halves** — what a colleague keeps to itself AND what every
//      colleague can see. The surveyed competitor's roster names only the first while sharing the
//      machine underneath (`notes/survey/grokbot-research.md`); a row that reads the same way here
//      would be promising an isolation we did not build.
//   2. **A control the API will refuse is not rendered.** Nova has no Retire button, and the endpoint
//      refuses it too — the UI is not the enforcement, it is the honest face of it.
//
// The ordering, filtering and disclosure decisions live in `@/apps/contacts` where tests reach them.

/** The rate window. Ten minutes is long enough that a pause between steps does not blank the badge,
 *  and short enough that "busy" means now rather than this afternoon. */
const RATE_WINDOW_MINUTES = 10

/** How often the rate badges re-read the clock. A per-minute figure that moves once a minute is
 *  as live as the number can honestly be, and it costs one signal write for the whole page. */
const RATE_TICK_MS = 60_000

/** The shared clock behind every row's rate badge — ONE ticker for the page, not one per row. */
const [nowTick, setNowTick] = createSignal(Date.now())

/**
 * Start that clock while the roster is on screen.
 *
 * ⚠️ Gated on `document.visibilityState`, matching `debug-bar.tsx` and `server-sync.tsx`: a badge
 * nobody is looking at does not need refreshing, and a timer that keeps firing behind a minimised
 * window is the shape of H3 in the same review.
 */
function useRateClock() {
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    if (timer !== undefined) return
    timer = setInterval(() => setNowTick(Date.now()), RATE_TICK_MS)
  }
  const sync = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      setNowTick(Date.now())
      start()
    } else stop()
  }
  onMount(() => {
    sync()
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", sync)
  })
  onCleanup(() => {
    stop()
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", sync)
  })
}

export function ContactsPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [hiring, setHiring] = createSignal(false)
  const [starting, setStarting] = createSignal<string | undefined>()
  const [cloning, setCloning] = createSignal<string | undefined>()
  const navigate = useNavigate()
  const sync = useServerSync()
  const dialog = useDialog()
  useRateClock()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })

  // 🔴 A failure here must be VISIBLE and must not throw. Two rules that fought each other until
  // the roster moved onto the server context:
  //   · A swallowed failure renders the empty state — "No colleagues yet" — which is a LIE when the
  //     request failed. Measured the hard way: the first draft of this page called the wrong client
  //     namespace, the catch turned a TypeError into an empty roster, and the screen looked like a
  //     working feature with nobody hired.
  //   · A REJECTED resource is worse (review D1, 2026-08-23): `read()` re-throws, `createMemo` is
  //     eager, and this app has exactly one ErrorBoundary — at its root — so an unreachable instance
  //     replaced the WHOLE UI rather than dimming this one list.
  // `ctx().agents` answers both: it degrades to `[]` for the surfaces that only want a list, and
  // keeps the failure on `error()` for this one, which is the surface that must name it.
  // ⚠️ ONE fetch, on the server context (review D8) — this page used to mint the third of three
  // independent `GET /api/agent`s, and the config dialog minted another on every open.
  const agents = () => ctx()?.agents.list()
  const agentsLoading = () => ctx()?.agents.loading() ?? true
  const agentsError = () => ctx()?.agents.error()
  const refetchAgents = () => ctx()?.agents.refetch()
  // What each colleague is WORKING ON — the half the roster inherits from the chat list it replaces.
  // A failure here dims the work column; it must never blank the roster, because "who works here"
  // and "what are they doing" are two questions and only one of them just failed.
  const [sessions, { refetch: refetchSessions }] = createResource(ctx, (current) =>
    listSessions(current.sdk.client.v2).catch(() => [] as SessionLike[]),
  )
  // How fast each colleague is going, from the per-minute series the projector writes. Refetched on
  // the same beat the page is looked at rather than polled: a roster is a glance, not a dashboard.
  const usageSource = createMemo(() => {
    const current = ctx()
    const ids = (agents() ?? []).map((row) => row.id)
    if (!current || ids.length === 0) return undefined
    return `${ServerConnection.key(conn()!)}\u0000${ids.join(",")}`
  })
  const [usage] = createResource(usageSource, (source) => {
    const separator = source.indexOf("\u0000")
    const ids = separator < 0 ? [] : source.slice(separator + 1).split(",")
    const current = ctx()
    return current === undefined
      ? Promise.resolve({} as Record<string, readonly UsageMinute[]>)
      : listUsage(current.sdk.client.v2 as never, ids)
  })

  // The lifecycle says whether a chat is RUNNING; this durable row says how its last attempt
  // stopped. Refetch when a terminal status arrives, so a recovery-paused colleague cannot be
  // flattened into healthy Idle. The status signature is the trigger rather than a timer: the
  // roster is a live projection, not a polling dashboard.
  const executionSource = createMemo(() => {
    const current = ctx()
    if (!current) return undefined
    const terminal = Object.entries(current.sync.session.data.session_status)
      .flatMap(([sessionID, status]) =>
        status.type === "idle" || status.type === "exited" ? [`${sessionID}:${status.type}`] : [],
      )
      .sort()
      .join("|")
    return { current, terminal }
  })
  const [executions] = createResource(executionSource, ({ current }) =>
    sessionExecutions(current.sdk.server.http).catch(() => [] as SessionExecutionInfo[]),
  )
  const executionBySession = createMemo(
    () => new Map((executions() ?? []).map((execution) => [execution.sessionID, execution])),
  )

  const serverKey = createMemo(() => {
    const current = conn()
    return current ? ServerConnection.key(current) : undefined
  })

  const hire = async () => {
    setHiring(true)
    try {
      const plan = planHire({ roster: agents() ?? [], random: Math.random })
      await sync().updateConfig({ agents: { [plan.id]: plan.fragment } } as never)
      // Straight into their config, on an empty job title — which is the question the user is
      // actually being asked. A colleague hired and left unopened is a name with no job.
      openConfig(plan.id)
      refetchAgents()
    } catch (error) {
      // Said, never swallowed: a hire that silently failed leaves the user pressing the button again.
      showToast({ variant: "error", title: language.t("contacts.hireFailed"), description: String(error) })
    } finally {
      setHiring(false)
    }
  }

  /** Hire a copy directly from the roster: same brief, new identity and an empty life. */
  const cloneColleague = async (agentID: string) => {
    const source = (agents() ?? []).find((row) => row.id === agentID)
    if (source === undefined) return
    setCloning(agentID)
    try {
      const plan = await cloneAgent({
        source,
        roster: agents() ?? [],
        random: Math.random,
        updateConfig: (patch) => sync().updateConfig(patch as never),
      })
      showToast({ variant: "success", title: language.t("agentConfig.clonedTitle", { name: plan.name }) })
      refetchAgents()
    } catch (error) {
      showToast(
        isNovaCloneRefusal(error)
          ? {
              title: language.t("agentConfig.cloneNovaTitle"),
              description: language.t("agentConfig.cloneNovaDescription"),
            }
          : { variant: "error", title: language.t("agentConfig.cloneFailed"), description: String(error) },
      )
    } finally {
      setCloning(undefined)
    }
  }

  /** Open a colleague who has no chat yet: create theirs, then go to it. */
  const startTheirChat = async (agentID: string, name: string) => {
    const current = ctx()
    const key = serverKey()
    if (current === undefined || key === undefined) return
    setStarting(agentID)
    try {
      const id = await startChat(current.sdk.client.v2 as never, { agentID, title: name })
      if (id === undefined) throw new Error("no session id came back")
      navigate(sessionHref(key, id))
    } catch (error) {
      // Said, never swallowed: a row that quietly refuses to open reads as a broken product.
      // ⚠️ And SAID IN WORDS THE USER CAN ACT ON. `String(error)` here produced
      // "TypeError: Failed to fetch", which names neither what was attempted, nor where, nor what to
      // do about it — the browser's words for whoever wrote the fetch call, shown to somebody who
      // just clicked a name in a list.
      const copy = describeFailure(error, { operation: `start a chat with ${name}`, target: key })
      showToast({
        variant: "error",
        title: copy.headline,
        description: copy.remedy
          ? `${copy.remedy}

${copy.detail}`
          : copy.detail,
      })
    } finally {
      setStarting(undefined)
    }
  }

  /**
   * The session list the roster actually reads: the fetched list, with the sync store's LIVE rows
   * laid over it (review D5).
   *
   * 🔴 The fetch alone froze the page. `sessions` was read once and refetched only when the config
   * dialog reported a change, so "what it is on", spend and rate — the three columns that make this
   * the replacement for the chat list — stopped moving the instant the page painted. Watching a
   * colleague work from the roster showed nothing happening.
   *
   * ⚠️ And the sync store alone is not enough either: `session.data.info` is a bounded LRU of the
   * sessions this client has SEEN through the event stream, not the instance's list. So the fetch
   * supplies completeness and the store supplies liveness, and the overlay order (store last) is
   * what makes a streaming update win over the copy fetched a minute ago.
   */
  const liveSessions = createMemo<readonly SessionLike[]>(() => {
    const merged = new Map<string, SessionLike>()
    for (const row of sessions() ?? []) merged.set(row.id, row)
    const info = sync().session.data.info
    for (const key of Object.keys(info)) {
      const row = info[key]
      if (row) merged.set(row.id, row)
    }
    return [...merged.values()]
  })

  const views = createMemo(() => roster(agents() ?? []))
  /** The colleagues the user hid — listed separately so their chats keep a door. */
  const hidden = createMemo(() => hiddenRoster(agents() ?? []))
  const shown = createMemo(() => searchRoster(views(), query()))

  /**
   * Open a colleague's config — through the DIALOG STACK, the same door the composer's Tune button
   * uses (owner, 2026-08-23).
   *
   * 🔴 It used to render inline, at the foot of this page's own flow. A `<div>` in the document
   * flow is not a modal: it squeezed the roster sideways to make room for itself, so opening a
   * colleague rearranged the list you had just been reading. Through the stack it covers the page,
   * traps focus, closes on Escape or the overlay, and carries the Back button that says which way
   * out is which. `showScoped`, not `show`: everything it renders reads THIS page's resources, so
   * navigating away must take the panel with it rather than leave it acting on a frozen copy.
   */
  const openConfig = (agentID: string) => {
    void dialog.showScoped(() => (
      // The SAME dialog the composer's Tune button opens — one place to learn what a colleague is
      // and how it behaves. Contacts passes no `tuning` section: there is no chat here to tune,
      // and an empty section would imply one.
      <AgentConfigDialog
        agentID={agentID}
        onDismiss={() => dialog.close()}
        // Both lists: a retirement changes WHO is here, a cleared chat changes what they are on.
        onChanged={() => {
          refetchAgents()
          void refetchSessions()
        }}
      />
    ))
  }

  return (
    <AppPage class="flex flex-col overflow-hidden">
      {/* 🔴 **The header is GONE** (owner, 2026-08-27: a *"missing (and unneeded) icon, superfluous
          'Contacts' title and useless and verbose 'Your colleagues…' description"*). Every part of it
          restated something the reader already knew: they opened this app from a tile that names it,
          so the title is an echo, and the sentence under it explained a roster that explains itself
          the moment you look at the rows. The glyph rendered as a blank besides. What the app is for
          belongs on the tile and in Help, not spent on the top of every visit. */}
      <div class="flex items-center gap-2 border-b border-v2-border-border-base px-4 py-2">
        {/* The user's own half of the CEO's power (owner: "user can create new agents on demand").
            Nova can hire through her tool; this is the same act performed by the person, sharing the
            same naming rule so the roster never reads like a list of people. */}
        <button
          type="button"
          class="shrink-0 rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs font-medium disabled:opacity-40"
          // 🔴 Disabled on a roster ERROR too, not only while loading. `agents()` degrades to `[]` when
          // the fetch fails, and `planHire` draws a name from the ids NOT taken — so an empty roster
          // reads as "every name is free" and the drawn id can land on a colleague who already has
          // it, giving the new hire their cabinet, their chat and their spend. Hiring off a roster we
          // could not read is the one moment the taken-set is guaranteed wrong.
          disabled={hiring() || agentsLoading() || agentsError() !== undefined}
          onClick={() => void hire()}
        >
          {hiring() ? language.t("contacts.hiring") : language.t("contacts.hire")}
        </button>
        <TextInputV2
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder={language.t("contacts.search")}
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        {/* Four distinct situations, four distinct sentences. An empty roster, a search that
            matched nothing, a roster still loading and a roster we FAILED to read are not the
            same fact, and collapsing them is how a broken request reads as "you have nobody".
            ⚠️ The failed/loading test is HOISTED ABOVE the `shown()` read (review D1): the guard
            used to evaluate `shown()`, which chains to `agents()`, so the branch that reports the
            failure could only be reached after the failure had already taken the page. */}
        <Show
          when={agentsError() === undefined && !agentsLoading()}
          fallback={
            <div class="px-4 py-6 text-sm text-v2-text-text-faint">
              <p>{agentsError() !== undefined ? language.t("contacts.loadFailed") : language.t("contacts.loading")}</p>
              {/* 🔴 A failure the user can ACT on (owner, 2026-08-28: *"lack of agents … should
                  trigger Novaclaw recovery sequence"*). The page already told the difference between
                  "nobody" and "could not read"; what it did not do was offer a way back, so a roster
                  that failed once stayed failed until the window was reopened. The retry is the same
                  refetch the reconnect engine runs — one recovery path, reachable by hand. */}
              <Show when={agentsError() !== undefined}>
                <button
                  type="button"
                  data-action="contacts-retry"
                  class="mt-3 rounded-md px-2 py-1 ring-1 ring-v2-border-border-base hover:bg-v2-background-bg-layer-02"
                  onClick={() => refetchAgents()}
                >
                  {language.t("contacts.retry")}
                </button>
              </Show>
            </div>
          }
        >
          <Show
            when={shown().length > 0}
            fallback={
              <p class="px-4 py-6 text-sm text-v2-text-text-faint">
                {views().length === 0 ? language.t("contacts.empty") : language.t("contacts.noMatch")}
              </p>
            }
          >
            <For each={shown()}>
              {(view) => (
                <ContactRow
                  view={view}
                  sessions={liveSessions()}
                  starting={starting() === view.id}
                  cloning={cloning() === view.id}
                  cloneDisabled={cloning() !== undefined}
                  onStart={() => void startTheirChat(view.id, view.name)}
                  onClone={() => void cloneColleague(view.id)}
                  usage={usage()?.[view.id] ?? []}
                  executions={executionBySession()}
                  serverKey={serverKey()}
                  onOpen={() => openConfig(view.id)}
                />
              )}
            </For>
          </Show>
        </Show>

        {/* HIDDEN COLLEAGUES — the door that hiding used to take away.
            🔴 `hidden: true` drops a row from the main roster while the colleague stays fully able to
            act (pausing, by contrast, denies it everything). The row is the only way into a
            colleague's chat, so a hidden colleague had a live chat and no door. Collapsed by default
            because hiding means "not one of my working colleagues" — but present, countable and one
            click from openable, which is the whole difference.
            ⚠️ Machinery is not in here: `hiddenRoster` keeps `isColleague`'s other two clauses, so
            `compaction`/`title` stay out and this reads as "you hid these" rather than an internals
            dump. */}
        <Show when={hidden().length > 0}>
          <details data-slot="contacts-hidden" class="border-t border-v2-border-border-muted">
            <summary class="cursor-pointer px-4 py-3 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02">
              {language.t("contacts.hiddenCount", { count: String(hidden().length) })}
            </summary>
            <For each={hidden()}>
              {(view) => (
                <ContactRow
                  view={view}
                  sessions={liveSessions()}
                  starting={starting() === view.id}
                  cloning={cloning() === view.id}
                  cloneDisabled={cloning() !== undefined}
                  onStart={() => void startTheirChat(view.id, view.name)}
                  onClone={() => void cloneColleague(view.id)}
                  usage={usage()?.[view.id] ?? []}
                  executions={executionBySession()}
                  serverKey={serverKey()}
                  onOpen={() => openConfig(view.id)}
                />
              )}
            </For>
          </details>
        </Show>

        {/* The HOUSEHOLD, at the foot of the roster and visibly not a colleague.
            🔴 It is here because the top-level Memory app is gone (2026-08-21): a global pile of
            memories was the same shape as the Chats list this roster replaced. What a colleague
            remembers is opened from that colleague; what EVERY colleague can read has no colleague to
            hang off, so it hangs off the list of them. Rendered as a plain row rather than a contact
            card on purpose — the household is not someone you can chat to, hire or retire, and a row
            that looked like a colleague would invite all three. */}
        <Show when={agentsError() === undefined && !agentsLoading()}>
          <button
            type="button"
            class="flex w-full items-center gap-3 border-t border-v2-border-border-muted px-4 py-3 text-left hover:bg-v2-background-bg-layer-02"
            onClick={() => navigate(SHARED_ROUTE)}
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03 text-sm">
              🏠
            </span>
            <span class="min-w-0">
              <span class="block truncate text-sm">{language.t("contacts.shared")}</span>
              <span class="block truncate text-[11px] text-v2-text-text-faint">
                {language.t("contacts.sharedHint")}
              </span>
            </span>
          </button>
        </Show>
      </div>
    </AppPage>
  )
}

function ContactRow(props: {
  view: ContactView
  /** The instance's sessions, unfiltered. ⚠️ The ROW derives its own live view from these.
   *  It used to take a ready-made `live={liveFor(...)}`, and solid compiles a call-expression prop
   *  to a GETTER — so each of this component's six reads re-ran `liveFor`, which allocates two
   *  fresh `Map`s over every session in the instance (review D6). One memo, one pass. */
  sessions: readonly SessionLike[]
  usage: readonly UsageMinute[]
  executions: ReadonlyMap<string, SessionExecutionInfo>
  starting: boolean
  cloning: boolean
  cloneDisabled: boolean
  onStart: () => void
  onClone: () => void
  serverKey: ServerConnection.Key | undefined
  onOpen: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const rowSync = useServerSync()
  const live = createMemo<RosterLive>(() => liveFor(props.sessions, props.view.id))
  // ⚠️ `now` is a SIGNAL, not a literal read (review D5). `Date.now()` inside the memo is untracked,
  // so the badge froze on the ten-minute window that ended when the page painted and went on
  // presenting it as a live rate. The ticker below is the only thing that makes "per minute" true.
  const rate = createMemo(() => ratePerMinute(props.usage, { now: nowTick(), window: RATE_WINDOW_MINUTES }))
  /**
   * The scheduler's own answer about this colleague's chat.
   *
   * 🔴 `serverSync().session.data`, which is where per-session liveness lives — NOT `serverSync().data`,
   * where I first looked and concluded, wrongly, that this page had no status source at all. The same
   * two accessors already drive the Home hero's RUNNING / T/S (`system-load.ts`), so the roster and
   * the hero cannot disagree about one session.
   */
  const sessionData = createMemo(() => rowSync().session.data)
  const state = createMemo(() => {
    const sessionID = live().sessionID
    if (sessionID === undefined) return "idle" as const
    return rosterState({
      status: sessionData().session_status[sessionID],
      working: sessionData().session_working(sessionID),
      execution: props.executions.get(sessionID),
    })
  })
  const task = createMemo(
    () =>
      rosterTask({ status: props.view.status, title: live().title, colleagueName: props.view.name }) ??
      (state() === "working" ? language.t("contacts.state.working") : undefined),
  )
  /**
   * The APPROXIMATE live rate, from the same snapshot the retired chat list showed.
   *
   * 🔴 **Approximate on purpose, and it must stay that way** (owner, 2026-08-27). A true token rate
   * needs the model's own tokenisation, which differs per model and is not knowledge this client has
   * or should acquire — so this is an estimate that comes out about right across models rather than
   * exact for any one. The `~` is part of the label for that reason: it is the difference between a
   * figure a reader can trust the meaning of and one that quietly claims a precision we do not have.
   *
   * ⚠️ **What it is FOR is liveness, not benchmarking.** A number moving here says the model and the
   * agent are both healthy and working; nobody should compare two colleagues by it, and nothing should
   * be tuned against it. Sharpening it is a job for a world where model servers are a reliable
   * standard — until then, more decimal places would only make the wrong reading easier to reach.
   *
   * `undefined` unless something is streaming, which is why an idle row carries no number, not a zero.
   */
  const perSecond = createMemo(() => {
    const sessionID = live().sessionID
    const tps = sessionID
      ? threadRate(props.sessions, sessionID, (id) => sessionData().session_live(id)?.tps)
      : undefined
    return formatTokensPerSecond(tps)
  })
  const workers = createMemo(() => {
    const sessionID = live().sessionID
    return sessionID === undefined
      ? []
      : workersOf(props.sessions, sessionID, (workerID) => ({
          lifecycle: sessionData().session_status[workerID]?.type,
          execution: props.executions.get(workerID)?.state,
        }))
  })
  const openWorkers = () => {
    const rows = workers()
    if (rows.length === 0 || props.serverKey === undefined) return
    void dialog.showScoped(() => (
      <Dialog size="normal" fit>
        <DialogHeader>
          <DialogTitle>{language.t("contacts.workers.title", { name: props.view.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody class="max-h-[70vh] overflow-y-auto p-2">
          <For each={rows}>
            {(worker, index) => (
              <A
                href={sessionHref(props.serverKey!, worker.id)}
                onClick={() => dialog.close()}
                class="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-v2-background-bg-layer-02"
              >
                <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03 text-xs">
                  {index() + 1}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">
                    {worker.title?.trim() || language.t("contacts.workers.untitled", { number: String(index() + 1) })}
                  </span>
                  <span class="block truncate text-[11px] text-v2-text-text-faint">
                    {language.t("contacts.workers.open")}
                  </span>
                </span>
              </A>
            )}
          </For>
        </DialogBody>
      </Dialog>
    ))
  }
  // The transcript's own formatter, so a timestamp reads the same in both places. Ticked by `nowTick`
  // so "today" stops being today at midnight without a reload.
  const lastTouched = createMemo(() => {
    const updated = live().updatedAt
    nowTick()
    return updated === undefined ? undefined : messageTime({ created: updated, locale: language.locale() })
  })
  /** The facts that FOLLOW the task, each present only when it has something to say. Built as a list
   *  so the separators can be joined between them rather than written beside each one. */
  const meta = createMemo<{ text: string; iso?: string; title?: string }[]>(() => {
    const parts: { text: string; iso?: string; title?: string }[] = [{ text: language.t(`contacts.state.${state()}`) }]
    const speed = perSecond()
    if (speed) parts.push({ text: language.t("contacts.perSecond", { tokens: speed }) })
    const stamp = lastTouched()
    const updated = live().updatedAt
    if (stamp && updated !== undefined) parts.push({ text: stamp.label, iso: stamp.iso, title: stamp.full })
    return parts
  })
  // The row IS the way into the colleague's one chat — that is what replacing the chat list means.
  // Its config is the gear beside it, so "talk to them" and "change them" are different gestures.
  // ⚠️ Through `sessionHref`, never hand-built. The route segment is BASE64 of the server key, and
  // interpolating the raw key produced `/server/http://localhost:4096/session/…` — a link that looks
  // right in the DOM and cannot resolve. Caught by reading the rendered hrefs, not by the typecheck.
  const chatHref = createMemo(() => {
    const sessionID = live().sessionID
    return sessionID && props.serverKey ? sessionHref(props.serverKey, sessionID) : undefined
  })
  return (
    <div class="flex w-full items-center gap-3 border-b border-v2-border-border-base px-4 py-3 transition-colors hover:bg-v2-background-bg-layer-02">
      <AgentPortrait
        id={props.view.id}
        name={props.view.name}
        avatar={props.view.avatar}
        background={agentColor(props.view.id, props.view.color)}
        class="size-9 border border-v2-border-border-strong text-base"
      />
      <Dynamic
        component={chatHref() ? A : "button"}
        {...(chatHref()
          ? { href: chatHref()! }
          : // No chat yet, so opening STARTS one — the row says so in words, and a button that did
            // something else would make its own label a lie.
            { type: "button" as const, onClick: props.onStart, disabled: props.starting })}
        class="min-w-0 flex-1 text-left"
      >
        <span class="flex items-center gap-2">
          <span class="truncate text-sm font-medium">{props.view.name}</span>
          <Show when={props.view.kind === "governing"}>
            <span class="rounded-full bg-v2-background-bg-layer-02 px-2 py-0.5 text-[10px] uppercase tracking-wide text-v2-text-text-muted">
              {language.t("contacts.governing")}
            </span>
          </Show>
          {/* ⚠️ A BADGE, not a dimmed or hidden row. A paused colleague is set aside, not gone —
              and the row is the only door to its chat, so anything that makes it harder to find
              recreates the problem pausing was built to solve. It reads as a state, beside the
              name, in the same place the governing badge sits. */}
          <Show when={props.view.paused}>
            <span
              data-state="paused"
              class="rounded-full bg-v2-state-bg-warning px-2 py-0.5 text-[10px] uppercase tracking-wide text-v2-state-fg-warning"
              title={language.t("contacts.pausedHint")}
            >
              {language.t("contacts.paused")}
            </span>
          </Show>
          <span class="truncate text-xs text-v2-text-text-muted">
            {props.view.title ?? language.t("contacts.noTitle")}
          </span>
        </span>
        {/* WHAT IT IS ON, and HOW IT IS DOING — one line, four facts, each absent when it has
            nothing to say (owner, 2026-08-27).
            🔴 The task is the chat's auto-title, but only when it is actually a task: `rosterTask`
            drops it when it merely echoes the colleague's name, which is what a fresh chat's title
            is. "No chat yet" is gone with it — the reader is being told about a TASK, and not having
            one is the same answer whether or not a conversation exists. */}
        <span class="block truncate text-xs">
          <Show when={task()} fallback={<span class="text-v2-text-text-faint">{language.t("contacts.noTask")}</span>}>
            {(value) => <span class="text-v2-text-text-base">{value()}</span>}
          </Show>
          {/* ⚠️ Separators are JOINED between the parts that exist, never written beside each one.
              Written inline, an absent rate left `No task · · 07:51 PM` on screen — a punctuation
              mark for a fact that is deliberately not rendered. Caught by looking at the row, not by
              the diff: every `Show` was individually correct.
              · The RATE is per second, absent rather than "0/s" — a zero reads as a measurement of
                the colleague's speed rather than of our decision to render it.
              · The TIME uses the transcript's own `messageTime`, so the clock-today / date-after
                rule cannot drift between the two surfaces. */}
          <For each={meta()}>
            {(part) => (
              <span class="text-v2-text-text-faint">
                {" · "}
                <Show when={part.iso !== undefined} fallback={part.text}>
                  <time dateTime={part.iso} title={part.title}>
                    {part.text}
                  </time>
                </Show>
              </span>
            )}
          </For>
        </span>
      </Dynamic>
      {/* Spend, rolled up over this colleague's chat AND the nameless staff it spawned — they spend
          on their officer's behalf. Absent rather than "0" when nothing has been produced: a zero
          reads as a measurement, and no work is not a measurement. */}
      {/* The RATE, when there is one. Absent — never "0/min" — when the colleague produced nothing
          in the window: the series is sparse, so no rows means not working, and a zero badge would
          read as a measurement of its speed rather than of our decision to render it. */}
      <Show when={rate()}>
        {(perMinute) => (
          <span
            class="shrink-0 text-[11px] tabular-nums text-v2-text-text-base"
            title={language.t("contacts.rateTitle", { window: RATE_WINDOW_MINUTES })}
          >
            {language.t("contacts.rate", { tokens: formatRate(perMinute()) })}
          </span>
        )}
      </Show>
      <Show when={live().tokens.generated > 0}>
        <span class="shrink-0 text-[11px] tabular-nums text-v2-text-text-faint" title={language.t("contacts.spend")}>
          {compactTokens(live().tokens.generated)}
        </span>
      </Show>
      <Show when={workers().length > 0 && props.serverKey !== undefined}>
        <button
          type="button"
          data-action="contacts-workers"
          onClick={openWorkers}
          class="shrink-0 rounded-md px-2 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base"
          title={language.t("contacts.workers.openAll", { name: props.view.name })}
        >
          {language.plural("contacts.workers.count", workers().length)}
        </button>
      </Show>
      <button
        type="button"
        data-action="contacts-clone"
        onClick={props.onClone}
        disabled={props.cloneDisabled}
        class="shrink-0 rounded-md px-2 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base disabled:opacity-40"
        title={language.t("contacts.clone", { name: props.view.name })}
        aria-label={language.t("contacts.clone", { name: props.view.name })}
      >
        {props.cloning ? language.t("agentConfig.cloning") : language.t("agentConfig.clone")}
      </button>
      <button
        type="button"
        onClick={props.onOpen}
        class="shrink-0 rounded-md p-1.5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base"
        title={language.t("contacts.configure")}
        aria-label={language.t("contacts.configure")}
      >
        <Icon name="settings-gear" class="size-4" />
      </button>
    </div>
  )
}
