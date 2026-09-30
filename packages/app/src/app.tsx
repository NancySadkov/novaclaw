import "@/index.css"
import { I18nProvider } from "@novaclaw/ui/context"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { FileComponentProvider } from "@novaclaw/ui/context/file"
import { MarkedProvider } from "@novaclaw/ui/context/marked"
import { agentFileResolver } from "@/apps/agent-file-link"
import { File } from "@novaclaw/session-ui/file"
import { Font } from "@novaclaw/ui/font"
import { ThemeProvider } from "@novaclaw/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { ConnectionBanner, supervisorReasonKey } from "@/components/connection-banner"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider, useServerSDK } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider, useNotification } from "@/context/notification"
import { usePlatform } from "@/context/platform"
import { useSupervisorPhase } from "@/hooks/use-supervisor-phase"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { ExpertiseMirror } from "@/components/expertise-mirror"
import { InstanceOriginMirror } from "@/components/instance-origin-mirror"
import { AppThemeEffect } from "@/context/app-theme"
import { TerminalProvider } from "@/context/terminal"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { DirectoryDataProvider, decodeDirectory } from "@/pages/directory-layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import {
  type ServerReachability,
  connectionErrorCopy,
  serverReachability,
  useCheckServerHealth,
} from "./utils/server-health"
import { legacySessionServer, requireServerKey, selectSessionLineage, sessionHref } from "./utils/session-route"
import { isSessionNotFoundError } from "./utils/server-errors"
import { forgetGoneSession, revalidateSessionTabs } from "./context/session-gone"
import { officerTabAgent } from "./context/tab-agent"
import { SessionScopeProvider } from "./context/session-scope"
import { resolveOfficerChat, cachedOfficerChat, rememberOfficerChat } from "./apps/agent-list"
import { showToast } from "@/utils/toast"

import { HomeScreen } from "@/pages/home-screen/home-screen"
import { clientLogPayload, installClientLogSender, installErrorLog } from "@/utils/error-log"
import { publicAssetUrl } from "@/utils/public-asset"
import { StartupScreen, useStartupScreen } from "@/components/startup-screen"

import { Session } from "@/pages/session-loader"
const FilesPage = lazy(() => import("@/pages/files").then(({ FilesPage }) => ({ default: FilesPage })))
const ProjectsPage = lazy(() => import("@/pages/projects").then(({ ProjectsPage }) => ({ default: ProjectsPage })))
const DebugPage = lazy(() => import("@/pages/debug").then(({ DebugPage }) => ({ default: DebugPage })))
const RegistryPage = lazy(() => import("@/pages/registry").then(({ RegistryPage }) => ({ default: RegistryPage })))
const ContactsPage = lazy(() => import("@/pages/contacts").then(({ ContactsPage }) => ({ default: ContactsPage })))
const AgentSettingsPage = lazy(() =>
  import("@/pages/agent-settings").then(({ AgentSettingsPage }) => ({ default: AgentSettingsPage })),
)
const TeamChatPage = lazy(() => import("@/pages/team-chat").then(({ TeamChatPage }) => ({ default: TeamChatPage })))
const SettingsPage = lazy(() => import("@/pages/settings").then(({ SettingsPage }) => ({ default: SettingsPage })))
const MemoryGraphPage = lazy(() =>
  import("@/pages/memory-graph").then(({ MemoryGraphPage }) => ({ default: MemoryGraphPage })),
)
const ModelsPage = lazy(() => import("@/pages/models").then(({ ModelsPage }) => ({ default: ModelsPage })))
const ModelSettingsPage = lazy(() =>
  import("@/pages/model-settings").then(({ ModelSettingsPage }) => ({ default: ModelSettingsPage })),
)
const TerminalPage = lazy(() => import("@/pages/terminal").then(({ TerminalPage }) => ({ default: TerminalPage })))

const NewSession = lazy(() => import("@/pages/new-session"))

/**
 * Compatibility redirects for the pre-tab URL shape — `/<base64 directory>[/session[/<id>]]`.
 *
 * Nothing in the shell *renders* there any more: the legacy app shell this used to hang under is
 * deleted. But the shape is still produced by OS notifications already sitting in a user's tray, by
 * `novaclaw://` deep links, and by a handful of in-app navigations, so it has to keep resolving. A
 * session id resolves to the canonical `/server/<key>/session/<id>`; without one it opens a fresh
 * draft in that directory, which is what `/:dir/session` always did.
 */
function LegacyDirectoryRoute() {
  const params = useParams<{ dir: string; id?: string }>()
  const [search] = useSearchParams<{ prompt?: string }>()
  const language = useLanguage()
  const navigate = useNavigate()
  const server = useServer()
  const tabs = useTabs()

  let opened = false
  createEffect(() => {
    if (params.id || opened) return
    if (!tabs.ready()) return
    opened = true
    const directory = decodeDirectory(params.dir)
    if (!directory) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("directory.error.invalidUrl"),
      })
      navigate("/", { replace: true })
      return
    }
    tabs.newDraft({ server: server.key, directory }, search.prompt)
  })

  return (
    <Show when={params.id} keyed>
      {(sessionID) => (
        <Show when={tabs.ready()}>
          <Navigate
            href={sessionHref(
              legacySessionServer(
                tabs.store.filter((item) => item.type === "session"),
                sessionID,
                server.key,
              ),
              sessionID,
            )}
          />
        </Show>
      )}
    </Show>
  )
}

const TargetSessionRoute = () => {
  const params = useParams<{ serverKey: string; id: string }>()
  const global = useGlobal()
  const conn = createMemo(() => {
    const key = requireServerKey(params.serverKey)
    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  return (
    <Show when={requireServerKey(params.serverKey)} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>
          <SessionTabRevalidate />
          <ResolvedTargetSessionRoute />
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

/**
 * The QUIET state while an officer's chat resolves.
 *
 * 🔴 Deliberately carries NO copy. It used to show `app.connection.reconnecting` — "Connection lost —
 * reconnecting…" — which reads as a dropped connection while the page is merely resolving a chat id
 * (owner, 2026-09-26). A resolve is not a disconnection, and a brief blank is the calm truth.
 */
function OfficerChatRecovering() {
  return (
    <div class="flex h-full items-center justify-center p-8" aria-busy="true" data-slot="officer-resolving">
      <span class="size-2 animate-pulse rounded-full bg-v2-text-text-muted" />
    </div>
  )
}

/** The calm scoped state for a chat that no longer exists — a normal lifecycle event in a
 *  multi-client OS (deleted from another window, the API, or server auto-prune), never a
 *  crash. Wire-accurate "Session not found" is wrong for humans: the chat was deleted. */
function SessionGoneCard() {
  const language = useLanguage()
  const navigate = useNavigate()
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span class="text-[15px] font-semibold text-v2-text-text-base">{language.t("session.gone.title")}</span>
      <span class="max-w-sm text-sm text-v2-text-text-muted">{language.t("session.gone.body")}</span>
      <button
        type="button"
        class="mt-2 rounded-md border border-v2-border-border-base px-3 py-1.5 text-sm text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-02"
        onClick={() => navigate("/")}
      >
        {language.t("session.gone.action")}
      </button>
    </div>
  )
}

/**
 * Re-validate the sessions the tab strip holds whenever this server's stream RECONNECTS.
 *
 * 🔴 A chat deleted by ANOTHER client while this renderer was disconnected never arrives as an
 * event, so ASKING is the only way its tab gets retired (owner, 2026-09-22: *"better be safe than
 * sorry and confused"*). It rides the reconnect BARRIER, so the strip is reconciled before the
 * connection is declared recovered; `revalidateSessionTabs` never rejects, so a check that cannot
 * run leaves the connection recovering exactly as it did before.
 *
 * ⚠️ It lives HERE, not in `server-sync.tsx`, because it needs the tab store and `tabs.tsx` imports
 * `@solidjs/router` — which cannot load under the unit preload. The session-sync module stays free of
 * that dependency so its pure helpers remain testable without a browser.
 */
function SessionTabRevalidate() {
  const serverSDK = useServerSDK()
  const sync = useServerSync()
  const tabs = useTabs()
  onCleanup(
    serverSDK().reconnectRecovery.register((signal: AbortSignal | undefined) =>
      revalidateSessionTabs({
        session: sync().session,
        tabs,
        server: ServerConnection.key(serverSDK().server),
        signal,
      }).then(() => undefined),
    ),
  )
  return null
}

function ResolvedTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  const tabs = useTabs()
  const sync = useServerSync()
  const serverKey = createMemo(() => requireServerKey(params.serverKey))
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const officerAgent = createMemo(() => officerTabAgent(tabs.store, serverKey(), params.id))
  const cached = createMemo(() => sync().session.lineage.peek(params.id))
  const [resolved] = createResource(
    () => {
      if (cached()) return
      return { id: params.id, server: serverKey(), sync: sync() }
    },
    ({ id, server, sync }) =>
      sync.session.lineage.resolve(id).catch((error) => {
        /**
         * 🔴 **A colleague's chat being gone is NOT the colleague being gone** (owner, 2026-09-26).
         * This used to retire every trace of the id — cache and tab — and the route then rendered
         * *"This chat was deleted or has expired"*. That is unreachable for an officer now: the id is
         * a pointer and the colleague is the identity, so the recovery below follows the colleague to
         * its current chat instead. Only a chat with NO colleague is genuinely gone here.
         */
        if (isSessionNotFoundError(error, id) && officerTabAgent(tabs.store, server, id) === undefined)
          forgetGoneSession({ session: sync.session, tabs, server, sessionID: id })
        throw error
      }),
  )
  // Reading an ERRORED resource rethrows its error — without the state guard the throw skips
  // the scoped fallback below and lands in the ROOT error boundary (the fatal "Something went
  // wrong" screen a deleted/pruned chat used to cause — issues.md P2).
  const current = createMemo(() =>
    selectSessionLineage(params.id, cached(), resolved.state === "errored" ? undefined : resolved()),
  )
  const directory = createMemo(() => current()?.session.location.directory)
  const targetDirectory = () => directory()!

  /**
   * 🔴 **RECOVERY BY COLLEAGUE.** When the route names a chat the server no longer has, and the tab
   * tells us which colleague owns it, ask the roster for that colleague's CURRENT chat — creating the
   * canonical one when it has none — and go there. This is the client half of "a colleague is an
   * entity and its chat is a component": the id can never strand an officer tab, so the "deleted or
   * expired" card is structurally unreachable for one.
   *
   * ⚠️ A plain effect, NOT a `createResource`: this is a one-shot side effect that NAVIGATES, not a
   * value a view renders, so it has no place in the settled-resource ledger. `forwarded` keys the
   * attempt to the dead id so a re-run cannot fire the lookup twice.
   */
  const [forwardError, setForwardError] = createSignal<unknown>()
  let forwarded = ""
  createEffect(() => {
    const agent = officerAgent()
    if (agent === undefined || current() !== undefined) return
    if (resolved.state !== "errored" || !isSessionNotFoundError(resolved.error, params.id)) return
    if (forwarded === params.id) return
    forwarded = params.id
    setForwardError(undefined)
    void resolveOfficerChat(serverSDK().client.v2, { agentID: agent })
      .then((successor) => {
        if (successor === undefined) {
          setForwardError(new Error(`${agent} has no chat to open`))
          return
        }
        tabs.addSessionTab({ server: serverKey(), sessionId: successor, agent })
        navigate(sessionHref(serverKey(), successor), { replace: true })
      })
      .catch((error) => setForwardError(error))
  })

  /**
   * 🔴 **The ONE-TAB-PER-COLLEAGUE rule reaches this door too** (owner, 2026-09-01: *"picking a
   * colleague in Contacts that already has an open tab does not switch to it"*). A roster row is a
   * plain `<A href={sessionHref(…)}>`, so Contacts arrives HERE — and this call used to hand
   * `addSessionTab` no `agent` at all, which makes the rule structurally inert: `findAgentTab`
   * returns -1 for `undefined` **by design**, so a colleague whose tab holds a different session of
   * theirs got a SECOND tab rather than being switched to.
   *
   * ⚠️ And the return value is load-bearing — `addSessionTab`'s own docblock says so: *"a caller
   * that ignored the result and navigated to its own session id would put the route and the strip on
   * two different chats."* This effect ignored it. When the store hands back the colleague's
   * standing tab, go THERE; that is what "switch to it" means.
   *
   * The navigation terminates: the second pass resolves the tab's own session, `addSessionTab`
   * matches it by key and returns it unchanged, and the ids agree.
   */
  createEffect(() => {
    const session = current()
    if (!session) return
    const opened = tabs.addSessionTab({
      server: serverKey(),
      sessionId: session.root.id,
      ...(session.root.agent === undefined ? {} : { agent: session.root.agent }),
      ...(session.root.parentID === undefined ? {} : { worker: true }),
    })
    if (opened.type === "session" && opened.sessionId !== session.root.id) tabs.select(opened)
  })

  return (
    <TargetServerScopedProviders directory={directory} sessionID={() => params.id}>
      <Show
        when={!!current() || resolved.state !== "errored"}
        fallback={
          officerAgent() !== undefined ? (
            forwardError() !== undefined ? (
              <ErrorPage error={forwardError()} />
            ) : (
              <OfficerChatRecovering />
            )
          ) : isSessionNotFoundError(resolved.error, params.id) ? (
            <SessionGoneCard />
          ) : (
            <ErrorPage error={resolved.error} />
          )
        }
      >
        <Show when={directory()}>
          <SDKProvider directory={targetDirectory}>
            <DirectoryDataProvider directory={targetDirectory} server={serverKey}>
              <TargetSessionPage />
            </DirectoryDataProvider>
          </SDKProvider>
        </Show>
      </Show>
    </TargetServerScopedProviders>
  )
}

/**
 * 🔴 THE AGENT-ADDRESSED ROUTE — a colleague is addressed by its id; its session is a component
 * resolved through it (AGENTS.md: *"session is just a component on top of the agent entity, and it is
 * accessed through agent's id, not as a first class entity"*).
 *
 * This is what makes Clear Chat a change of COMPONENT rather than a change of place: the URL stays on
 * the colleague, the tab keeps its identity and position, and anything open on the page (a context
 * inspector, a composer draft) is not thrown away because a transcript id changed. `refresh()` lets
 * Clear re-resolve the colleague's current chat in place.
 */
function TargetAgentRoute() {
  const params = useParams<{ serverKey: string; agentID: string }>()
  const serverSDK = useServerSDK()
  const sync = useServerSync()
  const serverKey = createMemo(() => requireServerKey(params.serverKey))
  const [revision, setRevision] = createSignal(0)
  const [chat, setChat] = createSignal<string>()
  const [directory, setDirectory] = createSignal<string>()
  const [failure, setFailure] = createSignal<unknown>()
  let run = 0
  // A one-shot side effect that NAVIGATES nothing and renders no value of its own — deliberately not
  // a `createResource` (the settled-resource ledger is shrink-only and these are id resolution, not
  // view data). `revision` re-runs it when Clear Chat asks the page to follow the colleague.
  createEffect(() => {
    const agent = params.agentID
    const key = serverKey()
    revision()
    const mine = ++run
    const known = cachedOfficerChat(key, agent)
    setFailure(undefined)
    if (known !== undefined) {
      // INSTANT: render the chat and directory we already know. No fetch on the critical path.
      setChat(known.id)
      setDirectory(known.directory ?? sync().session.peek(known.id)?.location?.directory)
    } else {
      setChat(undefined)
      setDirectory(undefined)
    }
    void resolveOfficerChat(serverSDK().client.v2, { agentID: agent, create: true, serverKey: key })
      .then(async (id) => {
        if (mine !== run) return
        // No live chat: ensure one, then render it. An officer page with NOTHING to show is the dead
        // end the roster's own "open to start one" gesture exists to avoid — and an unresolved page
        // that pulses forever is the "takes ages" the owner reported (measured live 2026-09-26).
        if (id === undefined) {
          setFailure(new Error(`${agent} has no chat`))
          return
        }
        const cached = cachedOfficerChat(key, agent)
        const knownDirectory = cached?.directory ?? sync().session.peek(id)?.location?.directory
        setChat(id)
        if (knownDirectory !== undefined) setDirectory(knownDirectory)
        else if (known?.id !== id) setDirectory(undefined)
        const lineage = await sync()
          .session.lineage.resolve(id)
          .catch(() => undefined)
        if (mine !== run) return
        const dir = lineage?.session.location.directory ?? knownDirectory
        if (dir !== undefined) setDirectory(dir)
        // Cache the directory too, so the NEXT open needs no fetch at all.
        if (dir !== undefined) rememberOfficerChat(key, agent, id, dir)
      })
      .catch((error) => {
        // A failed refresh must not tear down a page we already rendered from cache.
        if (mine === run && known === undefined) setFailure(error)
      })
  })
  const sessionID = () => chat()
  return (
    <SessionScopeProvider value={{ sessionID, refresh: () => setRevision((n) => n + 1) }}>
      <Show when={failure() === undefined} fallback={<ErrorPage error={failure()} />}>
        <Show when={directory()} fallback={<OfficerChatRecovering />}>
          <TargetServerScopedProviders directory={() => directory()!} sessionID={sessionID}>
            <SDKProvider directory={() => directory()!}>
              <DirectoryDataProvider directory={() => directory()!} server={serverKey}>
                <TargetSessionPage />
              </DirectoryDataProvider>
            </SDKProvider>
          </TargetServerScopedProviders>
        </Show>
      </Show>
    </SessionScopeProvider>
  )
}

function TargetSessionPage() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  return (
    <Show when={`${serverSDK().scope}\0${sdk().directory}`} keyed>
      <SessionProviders>
        <Session />
      </SessionProviders>
    </Show>
  )
}

// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell (Permission/Layout/
// Notification/Models + the visual Layout) for that server.
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>
          <SessionTabRevalidate />
          <DefaultDirectorySDK>{props.children}</DefaultDirectorySDK>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

/**
 * The directory-scoped SDK every route inherits.
 *
 * 🔴 `SDKProvider` is per-DIRECTORY, while the shell above supplies only the SERVER-scoped SDK. It
 * used to be mounted ad hoc by the session, draft and terminal routes, so any OTHER route that
 * mounted a `useSDK()` consumer threw "SDK context must be used within a context provider" and took
 * the window down — measured 2026-09-26 on Team Chat, which had just become a full-window route.
 * Providing it once here makes the omission unspellable: a new route cannot be added without it.
 * Session-bound routes still override it with their own directory beneath this one.
 */
function DefaultDirectorySDK(props: ParentProps) {
  const sync = useServerSync()
  return <SDKProvider directory={() => sync().data.path.directory}>{props.children}</SDKProvider>
}

function DraftRoute() {
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  return (
    <Show when={tabs.ready()}>
      <Show
        when={tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)}
        keyed
        fallback={<Navigate href="/" />}
      >
        {(draft) => <ResolvedDraftRoute draft={draft} />}
      </Show>
    </Show>
  )
}

function ResolvedDraftRoute(props: { draft: DraftTab }) {
  const global = useGlobal()
  const conn = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === props.draft.server))
  const directory = () => props.draft.directory
  const serverKey = () => props.draft.server

  return (
    <Show when={`${props.draft.server}\0${props.draft.directory}`} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>
          <TargetServerScopedProviders directory={directory}>
            <SDKProvider directory={directory}>
              <DirectoryDataProvider directory={directory} server={serverKey}>
                <DraftProviders>
                  <NewSession />
                </DraftProviders>
              </DirectoryDataProvider>
            </SDKProvider>
          </TargetServerScopedProviders>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return (
    <I18nProvider value={{ locale: language.intl, t: language.t, plural: language.plural }}>
      {props.children}
    </I18nProvider>
  )
}

declare global {
  interface Window {
    __NOVACLAW__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
      exportDebugLogs?: (serverDiagnostics?: string) => Promise<string>
      beginWindowDrag?: (clientX: number, clientY: number) => void
      moveWindowDrag?: () => void
      endWindowDrag?: () => void
    }
  }
}

// TanStack's retryer pauses between retries while the document is HIDDEN (focusManager), even
// under networkMode "always" — so a background/embedded/minimized window whose fetch failed once
// froze that query forever (refetch/invalidate dedupe into the paused attempt; measured live
// 2026-07-21 in the web preview, visibilityState "hidden"). We never focus-refetch (all three
// refetchOn* are off) and liveness rides the SSE stream, so focus-pausing buys nothing and
// breaks the never-dead-ends promise: pin the manager to focused.
focusManager.setFocused(true)

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        // Local-first: queries target the user's OWN instances (loopback/LAN), which are
        // reachable when the internet is not — TanStack's default networkMode "online" pauses a
        // failed fetch until the browser reports online, which froze a down-at-boot instance ctx
        // in fetchStatus "paused" forever (bootstrap never settled, refetch/invalidate no-oped;
        // measured live 2026-07-21). Failures must FAIL so the SSE-reconnect recovery can refetch.
        networkMode: "always",
      },
      mutations: {
        networkMode: "always",
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  createRenderEffect(() => {
    if (typeof document === "undefined") return

    document.body.toggleAttribute("data-new-layout", true)
    // Both HTML entries (packages/app/index.html, desktop/src/renderer/index.html) still ship the
    // legacy `text-12-regular` on <body>; strip it so the v2 type scale below wins.
    document.body.classList.remove("text-12-regular")
    document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <AppThemeEffect />
      <CommandProvider>{props.children}</CommandProvider>
    </>
  )
}

// Server-scoped providers shared by the legacy shell and the top-level new shell.
type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  sessionID?: () => string | undefined
}>

function ServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <LayoutProvider>
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </LayoutProvider>
  )
}

function NewAppLayout(props: ParentProps) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

function TargetServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <>
      <MarkSessionNotificationsViewed sessionID={props.sessionID} />
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </>
  )
}

function MarkSessionNotificationsViewed(props: { sessionID?: () => string | undefined }) {
  const notification = useNotification()
  createEffect(() => {
    const sessionID = props.sessionID?.()
    if (!notification.ready() || !sessionID) return
    if (notification.session.unseenCount(sessionID) === 0) return
    notification.session.markViewed(sessionID)
  })
  return null
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

// The draft page only renders the prompt composer, so it drops TerminalProvider.
// FileProvider and CommentsProvider stay because PromptInput uses file search and comment context.
function DraftProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  // Dependability P5: start capturing errors at boot — the Debug app's Error-log panel renders
  // whatever the window has seen, not just what happens after the panel opens.
  installErrorLog()
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error, reset) => {
                // Boundary-caught crashes never hit window.onerror — log them so the console and
                // the Debug app's error ring see the real failure, not just the calm page.
                console.error("app error boundary", error)
                return <ErrorPage error={error} reset={reset} />
              }}
            >
              <QueryProvider>
                <DialogProvider>
                  <MarkedProvider resolveFile={agentFileResolver}>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProvider>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const startup = useStartupScreen()
  const checkServerHealth = useCheckServerHealth()
  const { starting: supervisorStarting } = useSupervisorPhase()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // Repeated health check with a grace period for non-http connections; fails instantly otherwise.
  //
  // 🔴 The loop carries the CLASSIFICATION, not a boolean. `checkServerHealth` already separates a
  // 401/403 (the server answered and refused the credentials) from an outage, and this function
  // used to read `res.healthy` and throw that distinction away — so a user with a rotated token was
  // told their instance was unreachable and sent to restart a service that was fine. A rejection
  // ends the grace loop immediately: no amount of waiting turns a wrong password into a right one.
  const healthLoop = () =>
    Effect.gen(function* () {
      if (!server.current) return "unreachable" as ServerReachability
      const { http, type } = server.current

      while (true) {
        const reach = serverReachability(yield* Effect.promise(() => checkServerHealth(http)))
        if (reach !== "unreachable") return reach
        if (checkMode() === "background" || type === "http") return reach
        yield* Effect.sleep("250 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        // 🔴 Ten seconds is an OUTAGE budget, and applying it to a start is what turned a 9 s boot
        // into a 39 s hang: the gate gave up at 10 s, handed the user a full-screen "Could not reach
        // Local Server", and the app then sat on the SSE ladder's 250 ms→30 s backoff for another
        // 29 s while the instance it was describing was healthy and answering in 15 ms.
        //
        // A start is on a countdown the SHELL is keeping, and its own bound is 60 s
        // (`SIDECAR_START_STALL_TIMEOUT`). The gate waits on that bound while the supervisor says
        // `starting`, and keeps the 10 s budget for everything else — where a fast, honest answer is
        // the right one. The splash escalates at 8 s and 25 s, so a slow start is still narrated.
        duration: supervisorStarting() ? "55 seconds" : "10 seconds",
        orElse: () => Effect.succeed("unreachable" as ServerReachability),
      }),
    )

  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    Effect.gen(function* () {
      // Dependability P1: NO configured instance (a fresh desktop install whose sidecar failed to
      // initialize, or an emptied server list) must land on the calm connection screen — rendering
      // the app subtree without a server makes every useServerSDK/useServerSync memo throw and
      // dead-ends the whole app on the root ErrorPage. This check ignores disableHealthCheck (it
      // guards a render invariant, not liveness); ConnectionError's retry tick re-runs it, so the
      // screen clears by itself the moment an instance appears.
      if (!server.current) return "unreachable" as ServerReachability
      if (props.disableHealthCheck) return "ok" as ServerReachability
      return yield* healthLoop()
    }).pipe(
      // checkMode flips to background on EVERY outcome (including the no-server path) — the retry
      // tick in ConnectionError only refetches in background mode.
      Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
      Effect.runPromise,
    ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )
  createRenderEffect(() => {
    if (checking()) startup.begin(supervisorStarting() ? "server" : "connection")
    else startup.complete()
  })

  return (
    <Show when={!checking()}>
      <Show
        when={startupHealthCheck.latest === "ok"}
        fallback={
          <ConnectionError
            reachability={startupHealthCheck.latest ?? "unreachable"}
            onRetry={() => {
              if (checkMode() === "background") void healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              void healthCheckActions.refetch()
            }}
          />
        }
      >
        {/* Dependability P2: rendered ALONGSIDE children — the app stays interactive while the
            banner reports the outage (degraded contexts from P1 make that safe). */}
        <ConnectionBanner />
        {props.children}
      </Show>
    </Show>
  )
}

/**
 * Drain renderer faults to whichever whole instance the shell currently operates.
 *
 * This sits inside ServerProvider + GlobalProvider but outside ConnectionGate: errors captured while
 * an instance is reconnecting stay queued, and selecting another instance swaps the target without
 * remounting the app. Failures are intentionally silent here — console logging would feed the same
 * tap and manufacture an error loop; the bounded in-memory ring remains visible in Debug.
 */
function ClientErrorLogDrain() {
  const server = useServer()
  const global = useGlobal()

  createEffect(() => {
    const connection = server.current
    if (!connection) return
    const client = global.ensureServerCtx(connection).sdk.client
    const sender = async (entry: Parameters<typeof clientLogPayload>[0]) => {
      const response = await client.app.log(clientLogPayload(entry))
      return response.data === true
    }
    const remove = installClientLogSender(sender)
    onCleanup(remove)
  })

  return null
}

function ConnectionError(props: {
  reachability?: ServerReachability
  onRetry?: () => void
  onServerSelected?: (key: ServerConnection.Key) => void
}) {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const { phase, gaveUp: supervisorGaveUp, starting: supervisorStarting } = useSupervisorPhase()
  const restartReason = createMemo(() => {
    const current = phase()
    if (current?.phase !== "restarting" && current?.phase !== "gave-up") return undefined
    return supervisorReasonKey(current.reason)
  })
  const [repairing, setRepairing] = createSignal(false)
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  // The whole copy + probe-cadence decision comes from ONE total function, so a rejected
  // credential cannot pick the outage sentence back up the next time this screen is edited.
  const copy = createMemo(() =>
    connectionErrorCopy({
      hasServer: !!server.current,
      reachability: props.reachability ?? "unreachable",
      supervisorGaveUp: !!supervisorGaveUp(),
      supervisorStarting: !!supervisorStarting(),
    }),
  )
  const headline = createMemo(() => language.t(copy().headline, { server: serverToken }).split(serverToken))

  createEffect(() => {
    const timer = setInterval(() => props.onRetry?.(), copy().probeEveryMs)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <img
          src={publicAssetUrl("/logo.png")}
          alt="NovaClaw"
          draggable={false}
          class="w-14 h-14 mb-4 opacity-80 select-none"
        />
        {/* Dependability P1: the no-instance state (sidecar failed / server list emptied) gets
            honest copy instead of "could not reach <internal key>". Ruling 2: a REJECTED instance
            gets the credential sentence rather than an outage it is not having. */}
        <p class="text-14-regular text-text-base">
          {headline()[0]}
          <Show when={server.current}>
            <span class="text-text-strong font-medium">{name()}</span>
          </Show>
          {headline()[1]}
        </p>
        {/* 🔴 "Retrying automatically..." is a PROMISE, and it was false whenever the supervisor's
            bounded ladder had already stopped. Measured in the packaged app 2026-08-18: reloading
            mid-outage with the phase at `gave-up` showed this screen still promising a rescue nobody
            was attempting — the terminal panel could not help, because it lives behind the health
            gate this screen IS the failure of, so the phase replay reached an unmounted component.
            The phase comes from the same shared hook ConnectionBanner uses, so the two surfaces
            cannot disagree about whether the instance is coming back (they never co-render: the gate
            picks one). An absent supervisor stays `undefined` and keeps the calm copy. */}
        <p class="mt-1 text-12-regular text-text-weak max-w-80">{language.t(copy().detail)}</p>
        <Show when={restartReason()}>
          <p class="mt-1 text-12-regular text-text-weak max-w-80">{language.t(restartReason()!)}</p>
        </Show>
        <Show when={copy().detail === "app.connection.stopped.description"}>
          <button
            type="button"
            class="mt-3 px-3 py-1 rounded-md text-12-regular bg-surface-strong text-text-strong border border-border-weak-base hover:bg-surface-hover disabled:opacity-60"
            disabled={repairing()}
            onClick={() => {
              if (repairing()) return
              setRepairing(true)
              void platform.restart().catch(() => setRepairing(false))
            }}
          >
            {language.t(repairing() ? "app.connection.stopped.restarting" : "app.connection.stopped.restart")}
          </button>
        </Show>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  return (
    <StartupScreen>
      <ServerProvider
        defaultServer={props.defaultServer}
        canonicalLocalServer={props.canonicalLocalServer}
        servers={props.servers}
      >
        <GlobalProvider>
          <SettingsProvider>
            <ClientErrorLogDrain />
            <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
              <ExpertiseMirror />
              {/* File links a colleague writes must address the instance it RUNS ON, not the page's
                origin — the two differ whenever the user drives a remote instance, which is exactly
                when its files are otherwise unreachable. */}
              <InstanceOriginMirror />
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => (
                  <TabsProvider>
                    <NotificationProvider>
                      <ServerShell>
                        <NewAppLayout>{routerProps.children}</NewAppLayout>
                      </ServerShell>
                    </NotificationProvider>
                  </TabsProvider>
                )}
              >
                <Routes />
              </Dynamic>
            </ConnectionGate>
          </SettingsProvider>
        </GlobalProvider>
      </ServerProvider>
    </StartupScreen>
  )
}

function Routes() {
  return (
    <>
      <Route path="/" component={HomeScreen} />
      {/* 🔴 The chat list is RETIRED (owner, 2026-08-21). `/tasks` — the id the shell, the titlebar's
          "All tasks" and every user's muscle memory reach for — now lands on the ROSTER: one row per
          colleague, one chat each, instead of a list that only ever grew. `pages/home.tsx` is no
          longer routed; deleting its 900 lines and its tests is its own slice, so it is unreferenced
          rather than half-removed. */}
      <Route path="/tasks" component={ContactsPage} />
      <Route path="/officers/:agentID/settings" component={AgentSettingsPage} />
      {/* Team Chat is a place, not a sheet: the full-window surface a colleague's whole reporting
          team coordinates in. It rides the officer's tab like the settings screen beside it. */}
      <Route path="/officers/:agentID/team" component={TeamChatPage} />
      <Route path="/settings" component={SettingsPage} />
      {/* The app was renamed Chats → Tasks on 2026-08-13. A dead address is a dead end, and the
          catch-all below would otherwise try to base64-decode "chats" as a directory. */}
      <Route path="/chats" component={() => <Navigate href="/tasks" />} />
      <Route path="/files" component={FilesPage} />
      <Route path="/recipes" component={ProjectsPage} />
      <Route path="/projects" component={ProjectsPage} />
      <Route path="/debug/registry" component={RegistryPage} />
      <Route path="/debug" component={DebugPage} />
      {/* The roster answers to both names while people learn the new one. */}
      <Route path="/contacts" component={ContactsPage} />
      <Route path="/memory-graph" component={MemoryGraphPage} />
      {/* Trash retired as a route 2026-09-16 — it is a Settings → Safety tab now. */}
      <Route path="/models" component={ModelsPage} />
      {/* One model's configure surface, full screen like the officer's settings page. Ids ride search
          params because a catalog model id can contain a slash. */}
      <Route path="/models/configure" component={ModelSettingsPage} />
      <Route path="/terminal" component={TerminalPage} />
      <Route path="/new-session" component={DraftRoute} />
      <Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />
      <Route path="/server/:serverKey/agent/:agentID" component={TargetAgentRoute} />
      {/* Keep LAST: `/:dir` outranks nothing, and the static routes above must win the match. */}
      <Route path="/:dir" component={LegacyDirectoryRoute} />
      <Route path="/:dir/session/:id?" component={LegacyDirectoryRoute} />
    </>
  )
}
