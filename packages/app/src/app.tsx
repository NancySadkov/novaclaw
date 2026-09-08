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
import { ConnectionBanner } from "@/components/connection-banner"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider, useServerSDK } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
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
import { WslServersProvider } from "@/wsl/context"
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
import { showToast } from "@/utils/toast"

import { HomeScreen } from "@/pages/home-screen/home-screen"
import { clientLogPayload, installClientLogSender, installErrorLog } from "@/utils/error-log"
import { publicAssetUrl } from "@/utils/public-asset"

const Session = lazy(() => import("@/pages/session"))
const FilesPage = lazy(() => import("@/pages/files").then(({ FilesPage }) => ({ default: FilesPage })))
const NotesPage = lazy(() => import("@/pages/notes").then(({ NotesPage }) => ({ default: NotesPage })))
const CalendarPage = lazy(() => import("@/pages/calendar").then(({ CalendarPage }) => ({ default: CalendarPage })))
const RecipesPage = lazy(() => import("@/pages/recipes").then(({ RecipesPage }) => ({ default: RecipesPage })))
const SkillsPage = lazy(() => import("@/pages/skills").then(({ SkillsPage }) => ({ default: SkillsPage })))
const DebugPage = lazy(() => import("@/pages/debug").then(({ DebugPage }) => ({ default: DebugPage })))
const RegistryPage = lazy(() => import("@/pages/registry").then(({ RegistryPage }) => ({ default: RegistryPage })))
const ContactsPage = lazy(() => import("@/pages/contacts").then(({ ContactsPage }) => ({ default: ContactsPage })))
const MemoryGraphPage = lazy(() =>
  import("@/pages/memory-graph").then(({ MemoryGraphPage }) => ({ default: MemoryGraphPage })),
)
const TrashPage = lazy(() => import("@/pages/trash").then(({ TrashPage }) => ({ default: TrashPage })))
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
          <ResolvedTargetSessionRoute />
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
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

function ResolvedTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  const tabs = useTabs()
  const sync = useServerSync()
  const serverKey = createMemo(() => requireServerKey(params.serverKey))
  const cached = createMemo(() => sync().session.lineage.peek(params.id))
  const [resolved] = createResource(
    () => {
      if (cached()) return
      return { id: params.id, server: serverKey(), sync: sync() }
    },
    ({ id, server, sync }) =>
      sync.session.lineage.resolve(id).catch((error) => {
        if (isSessionNotFoundError(error, id)) tabs.removeSessionTab({ server, sessionId: id })
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
    })
    if (opened.type === "session" && opened.sessionId !== session.root.id) tabs.select(opened)
  })

  return (
    <TargetServerScopedProviders directory={directory} sessionID={() => params.id}>
      <Show
        when={!!current() || resolved.state !== "errored"}
        fallback={
          isSessionNotFoundError(resolved.error, params.id) ? <SessionGoneCard /> : <ErrorPage error={resolved.error} />
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
        <HighlightsProvider>
          <ServerSyncProvider>{props.children}</ServerSyncProvider>
        </HighlightsProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
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
                <WslServersProvider>
                  <DialogProvider>
                    <MarkedProvider resolveFile={agentFileResolver}>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
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
  const checkServerHealth = useCheckServerHealth()

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
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
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

  return (
    <Show
      when={!checking()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <img
            src={publicAssetUrl("/logo.png")}
            alt="NovaClaw"
            draggable={false}
            class="w-20 h-20 opacity-60 animate-pulse select-none"
          />
        </div>
      }
    >
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
  const { gaveUp: supervisorGaveUp } = useSupervisorPhase()
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
      {/* The app was renamed Chats → Tasks on 2026-08-13. A dead address is a dead end, and the
          catch-all below would otherwise try to base64-decode "chats" as a directory. */}
      <Route path="/chats" component={() => <Navigate href="/tasks" />} />
      <Route path="/files" component={FilesPage} />
      <Route path="/notes" component={NotesPage} />
      <Route path="/calendar" component={CalendarPage} />
      <Route path="/recipes" component={RecipesPage} />
      <Route path="/skills" component={SkillsPage} />
      <Route path="/registry" component={RegistryPage} />
      <Route path="/debug" component={DebugPage} />
      {/* The roster answers to both names while people learn the new one. */}
      <Route path="/contacts" component={ContactsPage} />
      <Route path="/memory-graph" component={MemoryGraphPage} />
      <Route path="/trash" component={TrashPage} />
      <Route path="/terminal" component={TerminalPage} />
      <Route path="/new-session" component={DraftRoute} />
      <Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />
      {/* Keep LAST: `/:dir` outranks nothing, and the static routes above must win the match. */}
      <Route path="/:dir" component={LegacyDirectoryRoute} />
      <Route path="/:dir/session/:id?" component={LegacyDirectoryRoute} />
    </>
  )
}
