import { A, useNavigate } from "@solidjs/router"
import { Dynamic } from "solid-js/web"
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { GoldGlyph } from "@/components/gold-glyph"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { AppPage } from "@/components/app-page"
import { agentColor } from "@/utils/agent"
import {
  hiddenRoster,
  memoryDisclosure,
  roster,
  searchRoster,
  type ContactView,
} from "@/apps/contacts"
import { SHARED_ROUTE } from "@/apps/memory-owner"
import { listSessions, listUsage, startChat } from "@/apps/agent-list"
import { planHire } from "@/apps/agent-hire"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import {
  formatRate,
  liveFor,
  ratePerMinute,
  type RosterLive,
  type SessionLike,
  type UsageMinute,
} from "@/apps/roster-live"
import { compactTokens } from "@/pages/home-session-meta"
import { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { AgentConfigDialog } from "@/components/agent-config-dialog"
import { useDialog } from "@novaclaw/ui/context/dialog"

// The Contacts app — the roster of colleagues this instance employs (AGENTS.md → *the structural
// metaphor*; `todo/named-agents.md`).
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
  const [usage] = createResource(
    () => {
      const current = ctx()
      const ids = (agents() ?? []).map((row) => row.id)
      return current && ids.length > 0 ? { current, ids } : undefined
    },
    ({ current, ids }) => listUsage(current.sdk.client.v2 as never, ids),
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
      showToast({ variant: "error", title: language.t("contacts.startFailed"), description: String(error) })
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
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <GoldGlyph name="user" class="size-6" />
        <span class="text-[15px] font-semibold">{language.t("contacts.title")}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">{language.t("contacts.hint")}</span>
      </div>

      <div class="flex items-center gap-2 border-b border-v2-border-border-base px-4 py-2">
        {/* The user's own half of the CEO's power (owner: "user can create new agents on demand").
            Nova can hire through her tool; this is the same act performed by the person, sharing the
            same naming rule so the roster never reads like a list of people. */}
        <button
          type="button"
          class="shrink-0 rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs font-medium disabled:opacity-40"
          disabled={hiring() || agentsLoading()}
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
            <p class="px-4 py-6 text-sm text-v2-text-text-faint">
              {agentsError() !== undefined ? language.t("contacts.loadFailed") : language.t("contacts.loading")}
            </p>
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
                  onStart={() => void startTheirChat(view.id, view.name)}
                  usage={usage()?.[view.id] ?? []}
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
                  onStart={() => void startTheirChat(view.id, view.name)}
                  usage={usage()?.[view.id] ?? []}
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
  starting: boolean
  onStart: () => void
  serverKey: ServerConnection.Key | undefined
  onOpen: () => void
}) {
  const language = useLanguage()
  const live = createMemo<RosterLive>(() => liveFor(props.sessions, props.view.id))
  const disclosure = createMemo(() => memoryDisclosure(props.view.memory))
  // ⚠️ `now` is a SIGNAL, not a literal read (review D5). `Date.now()` inside the memo is untracked,
  // so the badge froze on the ten-minute window that ended when the page painted and went on
  // presenting it as a live rate. The ticker below is the only thing that makes "per minute" true.
  const rate = createMemo(() => ratePerMinute(props.usage, { now: nowTick(), window: RATE_WINDOW_MINUTES }))
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
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-full text-base"
        style={{ "background-color": agentColor(props.view.id, props.view.color) }}
      >
        {props.view.avatar ?? props.view.name.charAt(0)}
      </span>
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
        {/* WHAT IT IS ON — the chat list's own auto-generated title, reused rather than a second
            title algorithm growing beside the first. A colleague with no chat yet says so plainly
            instead of showing an empty line that reads like a missing value. */}
        <span class="block truncate text-xs">
          <Show
            when={live().title}
            fallback={
              <span class="text-v2-text-text-faint">
                {live().sessionID
                  ? language.t("contacts.untitled")
                  : props.starting
                    ? language.t("contacts.starting")
                    : language.t("contacts.noChat")}
              </span>
            }
          >
            {(title) => <span class="text-v2-text-text-base">{title()}</span>}
          </Show>
        </span>
        {/* Both halves of the memory disclosure, on the row itself — not behind the detail view. */}
        <span class="block truncate text-[11px] text-v2-text-text-faint">
          {language.t(disclosure().privateKey)} · {language.t(disclosure().sharedKey)}
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
