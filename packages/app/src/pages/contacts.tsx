import { A, useNavigate } from "@solidjs/router"
import { Dynamic } from "solid-js/web"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { GoldGlyph } from "@/components/gold-glyph"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { AppPage } from "@/components/app-page"
import { agentColor } from "@/utils/agent"
import { memoryDisclosure, roster, searchRoster, type AgentLike, type ContactView } from "@/apps/contacts"
import { listAgents, listSessions, listUsage, startChat } from "@/apps/agent-list"
import { planHire } from "@/apps/agent-hire"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { formatRate, liveFor, ratePerMinute, type RosterLive, type SessionLike, type UsageMinute } from "@/apps/roster-live"
import { compactTokens } from "@/pages/home-session-meta"
import { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { AgentConfigDialog } from "@/components/agent-config-dialog"

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

export function ContactsPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const [hiring, setHiring] = createSignal(false)
  const [starting, setStarting] = createSignal<string | undefined>()
  const navigate = useNavigate()
  const sync = useServerSync()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })

  // ⚠️ NO `.catch(() => [])` here, and that is deliberate. A swallowed failure renders the empty
  // state — "No colleagues yet" — which is a LIE when the request failed: it tells the user their
  // organization is empty rather than that we could not read it. Measured the hard way: the first
  // draft of this page called the wrong client namespace, the catch turned a TypeError into an empty
  // roster, and the screen looked like a working feature with nobody hired.
  const [agents, { refetch: refetchAgents }] = createResource(ctx, (current) => listAgents(current.sdk.client.v2))
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
      setSelected(plan.id)
      void refetchAgents()
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

  const views = createMemo(() => roster(agents() ?? []))
  const shown = createMemo(() => searchRoster(views(), query()))
  const open = createMemo(() => views().find((view) => view.id === selected()))

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
          disabled={hiring() || agents.loading}
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
        <Show
          when={shown().length > 0}
          fallback={
            <p class="px-4 py-6 text-sm text-v2-text-text-faint">
              {/* Four distinct situations, four distinct sentences. An empty roster, a search that
                  matched nothing, a roster still loading and a roster we FAILED to read are not the
                  same fact, and collapsing them is how a broken request reads as "you have nobody". */}
              {agents.error !== undefined
                ? language.t("contacts.loadFailed")
                : agents.loading
                  ? language.t("contacts.loading")
                  : views().length === 0
                    ? language.t("contacts.empty")
                    : language.t("contacts.noMatch")}
            </p>
          }
        >
          <For each={shown()}>
            {(view) => (
              <ContactRow
                view={view}
                live={liveFor(sessions() ?? [], view.id)}
                starting={starting() === view.id}
                onStart={() => void startTheirChat(view.id, view.name)}
                usage={usage()?.[view.id] ?? []}
                serverKey={serverKey()}
                onOpen={() => setSelected(view.id)}
              />
            )}
          </For>
        </Show>
      </div>

      {/* The SAME dialog the composer's Tune button opens — one place to learn what a colleague is
          and how it behaves. Contacts passes no `tuning` section: there is no chat here to tune, and
          an empty section would imply one. */}
      <Show when={open()}>
        {(view) => (
          <AgentConfigDialog
            agentID={view().id}
            onDismiss={() => setSelected(undefined)}
            // Both lists: a retirement changes WHO is here, a cleared chat changes what they are on.
            onChanged={() => {
              void refetchAgents()
              void refetchSessions()
            }}
          />
        )}
      </Show>
    </AppPage>
  )
}

function ContactRow(props: {
  view: ContactView
  live: RosterLive
  usage: readonly UsageMinute[]
  starting: boolean
  onStart: () => void
  serverKey: ServerConnection.Key | undefined
  onOpen: () => void
}) {
  const language = useLanguage()
  const disclosure = createMemo(() => memoryDisclosure(props.view.memory))
  const rate = createMemo(() => ratePerMinute(props.usage, { now: Date.now(), window: RATE_WINDOW_MINUTES }))
  // The row IS the way into the colleague's one chat — that is what replacing the chat list means.
  // Its config is the gear beside it, so "talk to them" and "change them" are different gestures.
  // ⚠️ Through `sessionHref`, never hand-built. The route segment is BASE64 of the server key, and
  // interpolating the raw key produced `/server/http://localhost:4096/session/…` — a link that looks
  // right in the DOM and cannot resolve. Caught by reading the rendered hrefs, not by the typecheck.
  const chatHref = createMemo(() =>
    props.live.sessionID && props.serverKey ? sessionHref(props.serverKey, props.live.sessionID) : undefined,
  )
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
          <span class="truncate text-xs text-v2-text-text-muted">
            {props.view.title ?? language.t("contacts.noTitle")}
          </span>
        </span>
        {/* WHAT IT IS ON — the chat list's own auto-generated title, reused rather than a second
            title algorithm growing beside the first. A colleague with no chat yet says so plainly
            instead of showing an empty line that reads like a missing value. */}
        <span class="block truncate text-xs">
          <Show
            when={props.live.title}
            fallback={
              <span class="text-v2-text-text-faint">
                {props.live.sessionID
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
      <Show when={props.live.tokens.generated > 0}>
        <span class="shrink-0 text-[11px] tabular-nums text-v2-text-text-faint" title={language.t("contacts.spend")}>
          {compactTokens(props.live.tokens.generated)}
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
