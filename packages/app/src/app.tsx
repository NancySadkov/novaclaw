import "@/index.css"
import { I18nProvider } from "@novaclaw/ui/context"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { FileComponentProvider } from "@novaclaw/ui/context/file"
import { MarkedProvider } from "@novaclaw/ui/context/marked"
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
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { ExpertiseMirror } from "@/components/expertise-mirror"
import { AppThemeEffect } from "@/context/app-theme"
import { TerminalProvider } from "@/context/terminal"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import LegacyLayout from "@/pages/layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import {
  legacySessionHref,
  legacySessionServer,
  requireServerKey,
  selectSessionLineage,
  sessionHref,
} from "./utils/session-route"
import { isSessionNotFoundError } from "./utils/server-errors"

import Session from "@/pages/session"
import { NewHome, LegacyHome } from "@/pages/home"
import { HomeScreen } from "@/pages/home-screen/home-screen"
import { FilesPage } from "@/pages/files"
import { NotesPage } from "@/pages/notes"
import { CalendarPage } from "@/pages/calendar"
import { RecipesPage } from "@/pages/recipes"
import { DebugPage } from "@/pages/debug"
import { RegistryPage } from "@/pages/registry"
import { MemoryGraphPage } from "@/pages/memory-graph"
import { TrashPage } from "@/pages/trash"
import { installErrorLog } from "@/utils/error-log"

const NewSession = lazy(() => import("@/pages/new-session"))

const SessionRoute = () => {
  const settings = useSettings()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()

  if (params.id && settings.general.newLayoutDesigns()) {
    const sessionID = params.id
    return (
      <Show when={tabs.ready()}>
        {(_) => {
          const persisted = tabs.store.filter((item) => item.type === "session")
          return <Navigate href={sessionHref(legacySessionServer(persisted, sessionID, server.key), sessionID)} />
        }}
      </Show>
    )
  }

  // When the new layout is enabled, the legacy new-session route (/:dir/session with no id)
  // is replaced by a draft at /new-session?draftId=…
  createEffect(() => {
    if (!settings.general.newLayoutDesigns()) return
    if (params.id || search.draftId) return
    if (!tabs.ready() || !sdk().directory) return
    tabs.newDraft({ server: server.key, directory: sdk().directory }, search.prompt)
  })

  return (
    <SessionProviders>
      <Session />
    </SessionProviders>
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
  const settings = useSettings()
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

  createEffect(() => {
    const session = current()
    if (!session) return
    tabs.addSessionTab({
      server: serverKey(),
      sessionId: session.root.id,
    })
  })

  return (
    <TargetServerScopedProviders directory={directory} sessionID={() => params.id}>
      <Show
        when={!!current() || resolved.state !== "errored"}
        fallback={
          isSessionNotFoundError(resolved.error, params.id) ? (
            <SessionGoneCard />
          ) : (
            <ErrorPage error={resolved.error} />
          )
        }
      >
        <Show when={directory()}>
          <Show
            when={settings.general.newLayoutDesigns()}
            fallback={<Navigate href={legacySessionHref(directory()!, params.id)} />}
          >
            <SDKProvider directory={targetDirectory}>
              <DirectoryDataProvider directory={targetDirectory} server={serverKey}>
                <TargetSessionPage />
              </DirectoryDataProvider>
            </SDKProvider>
          </Show>
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
        <ServerSyncProvider>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

function LegacyServerLayout(props: ParentProps) {
  return (
    <SelectedServerProviders>
      <LegacyServerScopedShell>{props.children}</LegacyServerScopedShell>
    </SelectedServerProviders>
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
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __NOVACLAW__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
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
  const settings = useSettings()

  createRenderEffect(() => {
    if (typeof document === "undefined") return

    const enabled = settings.general.newLayoutDesigns()
    document.body.toggleAttribute("data-new-layout", enabled)
    document.body.classList.toggle("text-12-regular", !enabled)
    document.body.classList.toggle("font-(family-name:--font-family-text)", enabled)
    document.body.classList.toggle("text-[13px]", enabled)
    document.body.classList.toggle("font-[440]", enabled)
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
      <CommandProvider>
        <HighlightsProvider>{props.children}</HighlightsProvider>
      </CommandProvider>
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
    <PermissionProvider directory={props.directory}>
      <LayoutProvider>
        <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
      </LayoutProvider>
    </PermissionProvider>
  )
}

function LegacyServerScopedShell(props: ServerScopedShellProps) {
  return (
    <ServerScopedProviders directory={props.directory} sessionID={props.sessionID}>
      <LegacyLayout>{props.children}</LegacyLayout>
    </ServerScopedProviders>
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
    <PermissionProvider directory={props.directory}>
      <MarkSessionNotificationsViewed sessionID={props.sessionID} />
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </PermissionProvider>
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
                    <MarkedProvider>
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
  const healthLoop = () =>
    Effect.gen(function* () {
      if (!server.current) return false
      const { http, type } = server.current

      while (true) {
        const res = yield* Effect.promise(() => checkServerHealth(http))
        if (res.healthy) return true
        if (checkMode() === "background" || type === "http") return false
      }
    }).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }))

  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    Effect.gen(function* () {
      // Dependability P1: NO configured instance (a fresh desktop install whose sidecar failed to
      // initialize, or an emptied server list) must land on the calm connection screen — rendering
      // the app subtree without a server makes every useServerSDK/useServerSync memo throw and
      // dead-ends the whole app on the root ErrorPage. This check ignores disableHealthCheck (it
      // guards a render invariant, not liveness); ConnectionError's retry tick re-runs it, so the
      // screen clears by itself the moment an instance appears.
      if (!server.current) return false
      if (props.disableHealthCheck) return true
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
            src="/logo.png"
            alt="NovaClaw"
            draggable={false}
            class="w-20 h-20 opacity-60 animate-pulse select-none"
          />
        </div>
      }
    >
      <Show
        when={startupHealthCheck.latest}
        fallback={
          <ConnectionError
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

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <img src="/logo.png" alt="NovaClaw" draggable={false} class="w-14 h-14 mb-4 opacity-80 select-none" />
        <Show
          when={server.current}
          fallback={
            // Dependability P1: the no-instance state (sidecar failed / server list emptied) gets
            // honest copy instead of "could not reach <internal key>".
            <p class="text-14-regular text-text-base">{language.t("app.server.none")}</p>
          }
        >
          <p class="text-14-regular text-text-base">
            {unreachable()[0]}
            <span class="text-text-strong font-medium">{name()}</span>
            {unreachable()[1]}
          </p>
        </Show>
        <p class="mt-1 text-12-regular text-text-weak">
          {server.current ? language.t("app.server.retrying") : language.t("app.server.noneHint")}
        </p>
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
          <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
            <ExpertiseMirror />
            <Show when={useSettings().general.newLayoutDesigns().toString()} keyed>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => (
                  <TabsProvider>
                    <NotificationProvider>
                      <ServerShell>
                        <Show when={useSettings().general.newLayoutDesigns()} fallback={routerProps.children}>
                          <NewAppLayout>{routerProps.children}</NewAppLayout>
                        </Show>
                      </ServerShell>
                    </NotificationProvider>
                  </TabsProvider>
                )}
              >
                <Routes />
              </Dynamic>
            </Show>
          </ConnectionGate>
        </SettingsProvider>
      </GlobalProvider>
    </ServerProvider>
  )
}

function Routes() {
  const settings = useSettings()

  return (
    <>
      <Route component={LegacyServerLayout}>
        <Show when={!settings.general.newLayoutDesigns()}>{<Route path="/" component={LegacyHome} />}</Show>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Route>
      <Show when={settings.general.newLayoutDesigns()}>
        <Route path="/" component={HomeScreen} />
        <Route path="/chats" component={NewHome} />
        <Route path="/files" component={FilesPage} />
        <Route path="/notes" component={NotesPage} />
        <Route path="/calendar" component={CalendarPage} />
        <Route path="/recipes" component={RecipesPage} />
        <Route path="/registry" component={RegistryPage} />
        <Route path="/debug" component={DebugPage} />
        <Route path="/memory-graph" component={MemoryGraphPage} />
        <Route path="/trash" component={TrashPage} />
        <Route path="/:dir/session/:id" component={LegacyTargetSessionRoute} />
      </Show>
      <Route path="/new-session" component={DraftRoute} />
      <Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />
    </>
  )
}

function LegacyTargetSessionRoute() {
  const server = useServer()
  const tabs = useTabs()
  const params = useParams<{ id: string }>()

  return (
    <Show when={tabs.ready()}>
      <Navigate
        href={sessionHref(
          legacySessionServer(
            tabs.store.filter((item) => item.type === "session"),
            params.id,
            server.key,
          ),
          params.id,
        )}
      />
    </Show>
  )
}
