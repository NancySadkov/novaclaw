import type { Config, NovaclawClient, Path, V2Event } from "@novaclaw/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@novaclaw/core/util/path"
import { type Accessor, batch, createMemo, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
import { notifySessionAgentChats, notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  globalReady,
  isCancelledError,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { loadPersistedApps } from "@/apps/persisted"
import { mergeSession } from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createInstanceRecovery } from "./global-sync/instance-recovery"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@novaclaw/ui/context"
import { createConfigRemover } from "@/utils/config-remove"
import { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { type createServerProjects, ServerConnection, useServer } from "./server"
import { retry } from "@novaclaw/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { persisted } from "@/utils/persist"
import { toggleMcp } from "./global-sync/mcp"
import { createServerSession } from "./server-session"
import { createNativeMessageStore } from "./global-sync/message-v2-store"
import { withRequestDeadline } from "@/utils/request-deadline"
import { afterFirstPaint } from "@/utils/after-first-paint"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  provider: NormalizedProviderListResponse
  config: Config
  reload: undefined | "pending"
}

export const loadMcpQuery = (scope: ServerScope, directory: string, sdk: NovaclawClient) =>
  queryOptions({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: ({ signal }) => sdk.mcp.status(undefined, { signal }).then((r) => r.data ?? {}),
  })

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => NovaclawClient,
  sdkFor: (dir: PathKey) => NovaclawClient,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, sdkFor(directory)),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export type ConfigUpdateOptions = {
  readonly onAccepted?: () => void
  readonly refetch?: boolean
}

/** The ordering boundary for auth rotations: switch credentials before any follow-up request. */
export function settleConfigUpdate(options: ConfigUpdateOptions, refetch: () => void) {
  options.onAccepted?.()
  if (options.refetch !== false) refetch()
}

export function createServerSyncContextInner(serverSDK: ServerSDK, projects: ReturnType<typeof createServerProjects>) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")
  const lifetime = new AbortController()
  let closed = false

  const sdkCache = new Map<string, NovaclawClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))

  // ⚠️ Hoisted and ANNOTATED, not inlined into `createStore`. `ready` derives from `error`, so a
  // getter naming `globalStore` makes that binding's type circular through its own initializer
  // (TS7022) — and an accessor may not declare a `this` parameter (TS2784), so neither shortcut is
  // available. `createStore` proxies this object, so `initial.error` reads what `setGlobalStore`
  // wrote.
  const initial: GlobalStore = {
    get ready() {
      // ⚠️ Not `!bootstrap.isPending` alone. Each getter below answers with a private EMPTY literal
      // whenever its query holds no data, so "the boot settled" and "the boot worked" render
      // identically — a half-started instance would report itself ready over a config, provider list
      // and path it never loaded. `bootstrapGlobal` writes `error` on failure and clears it on a
      // later success, and it is the only thing that tells the two apart.
      return globalReady({ pending: bootstrap.isPending, error: initial.error })
    },
    get path() {
      const EMPTY = { state: "", config: "", data: "", roots: [], worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), models: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  }
  const [globalStore, setGlobalStore] = createStore<GlobalStore>(initial)

  const queryClient = useQueryClient()

  let bootedAt = 0
  let cancelEventStart: (() => void) | undefined

  onCleanup(() => cancelEventStart?.())

  const setBootStore = setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrapInstance,
  })

  const session = createServerSession(serverSDK.client)

  // 🔴 Instance-scoped bootstraps. REGISTERED, not called — `recovery.sweep()` below performs the
  // first load, and `server.connected` performs every later one. Before this they were bare calls
  // here, so they ran once per ctx and never again: a dropped stream left tags, presence and the
  // app manifests stale until the user reloaded the page, because the reconnect sweep enumerates
  // DIRECTORY stores and none of these is one. See `instance-recovery.ts` for the class.
  const recovery = createInstanceRecovery()
  // Tags component bootstrap (notes/reports/entities-review-2026-07-06.md T0) — instance-wide.
  recovery.register("session.tags", () => void session.loadTags())
  // Presence — who is attached to what, right now. Everything after the read arrives as
  // `session.presence.updated`. This read doubles as the instance's sweep for rooms whose last
  // viewer vanished without saying goodbye, which is precisely why it must run again on reconnect:
  // the viewers that vanished DURING the outage are the ones nothing else will report.
  recovery.register("session.presence", () => void session.loadPresence())
  // Persisted app manifests. `app.registered` refreshes them while connected; nothing refreshed them
  // after an outage, so an app registered while the stream was down stayed invisible.
  recovery.register(
    "apps.persisted",
    () => void loadPersistedApps(serverSDK.server.http, ServerConnection.key(serverSDK.server)),
  )
  recovery.sweep()
  const nativeMessages = createNativeMessageStore(serverSDK.client)
  // A live transport is not yet a recovered client. Keep the connection unavailable until every
  // resident transcript has been authoritatively re-read; a failed read makes the stream loop
  // reconnect and retry instead of exposing a stale prompt.
  const unregisterMessageRecovery = serverSDK.reconnectRecovery.register(() => nativeMessages.reconcileAll())
  const agentStatusListeners = new Set<() => void>()

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      if (closed) return
      void retry(() =>
        sdkFor(directory)
          .command.list()
          .then((x) => setStore("command", x.data ?? [])),
      ).catch((err) => {
        showToast({
          variant: "error",
          title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
          description: formatServerError(err, language.t),
        })
      })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
  })

  async function loadSessions(directory: string, options?: { limit?: number }) {
    if (closed) return
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      if (closed) return
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, { limit: retainedLimit })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: ({ signal }) =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            signal,
            list: (query, options) =>
              serverSDK.client.v2.session
                .list(query, options)
                .then((r) => ({ data: r.data?.data ? [...r.data.data] : undefined })),
          })
            .then((x) => {
              if (closed || lifetime.signal.aborted) return
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const next = trimSessions([...nonArchived, ...childSessions], { limit })
              batch(() => {
                next.forEach(session.remember)
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              if (isCancelledError(err)) return
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  // Hydrate a directory's CHILD sessions into its store (uix-improvement slice 4). The roots-only
  // list (`loadSessions`) never carries them, so on a fresh load the Chats threads tree would only
  // fill from live spawn events. Best-effort: children are progressive enhancement over the roots
  // list; `loadSessions`' reconcile preserves child rows already in the store.
  async function loadChildSessions(directory: string, options?: { limit?: number }) {
    if (closed) return
    const key = directoryKey(directory)
    children.pin(key)
    try {
      const [, setStore] = children.child(directory, { bootstrap: false })
      const response = await withRequestDeadline({
        label: "Loading child sessions",
        signal: lifetime.signal,
        run: (signal) => serverSDK.client.v2.session.list({ directory, limit: options?.limit ?? 200 }, { signal }),
      })
      const result = { data: response.data?.data ? [...response.data.data] : undefined }
      if (closed || lifetime.signal.aborted) return
      const nonRoot = (result.data ?? []).filter((s) => !!s?.id && !!s.parentID && !s.time?.archived)
      if (nonRoot.length) {
        batch(() => {
          nonRoot.forEach((s) => mergeSession(setStore, s))
          nonRoot.forEach(session.remember)
        })
      }
    } catch {
      // Non-fatal: the roots list already rendered; children fill in on the next live event.
    } finally {
      children.unpin(key)
    }
  }

  async function bootstrapInstance(directory: string) {
    if (closed) return
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      if (closed || lifetime.signal.aborted) return
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
        session,
        // An open-project row is client navigation state, not chat data. Once the instance confirms
        // its folder is gone, retire that row so every cold start does not retry it and emit another
        // warning. Restoring/reopening the folder adds it again; the chats themselves are untouched.
        onDirectoryMissing: (missing) => projects.close(missing),
        signal: lifetime.signal,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = serverSDK.event.listen((e) => {
    if (closed) return
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = Date.now() - bootedAt < 1500

    session.apply(event)
    const type = event.type as string

    // A chat deleted from ANYWHERE — another client, the raw API, server auto-prune — must close
    // its open tabs/routes too. UI-initiated deletes notify locally (which masked this gap); the
    // event stream is the only signal for the rest, and a tab left alive 404s on its next fetch,
    // which used to feed the ROOT error boundary and take down the whole shell (issues.md P2).
    if ((event.type as string) === "session.deleted") {
      const deleted = (event as { properties?: { info?: { id?: string; location?: { directory?: string } } } })
        .properties?.info
      if (deleted?.id) {
        notifySessionTabsRemoved({
          server: ServerConnection.key(serverSDK.server),
          directory: deleted.location?.directory ?? directory,
          sessionIDs: [deleted.id],
        })
      }
    }

    // F1e (strategy B, parallel): also fold the raw session.next.* events into the native store.
    // The bridge emits them non-sync alongside the v1 translation, so they already arrive here;
    // adapt the bus envelope { type, properties } -> the fold's { type, data }. The store ignores
    // non-session.next.* events. It IS the transcript render path (`NativeTimeline` →
    // `NativeTranscript`) — see `global-sync/message-v2-store.ts`'s header — so a fold that drops an
    // event here is a user-visible missing message, not a bookkeeping miss.
    const rawEvent = event as { type: string; properties?: unknown }
    nativeMessages.apply({ type: rawEvent.type, data: rawEvent.properties } as unknown as V2Event)

    // B14: a home-app manifest was registered (agent tool -> EventV2 bridge, or POST /app ->
    // GlobalBus) — refetch the persisted list regardless of which directory the event rode in on.
    // (The event union in the generated SDK predates app.registered — hence the cast.)
    if ((event.type as string) === "app.registered")
      void loadPersistedApps(serverSDK.server.http, ServerConnection.key(serverSDK.server))

    // The instance catalog (providers/models) is seeded a beat AFTER the server starts accepting
    // connections, so the very first `/provider` fetch at cold start can land empty — and with
    // refetchOnMount disabled it stays stuck (this blanked Settings → Models and the home model list
    // while directory catalogs, fetched later, still populated the in-session picker). Re-pull every
    // provider query (global + per-directory) whenever the catalog changes or the event stream
    // (re)connects; by then the catalog is ready. `catalog.updated` can fire before we subscribe, so
    // `server.connected` — always delivered to us on connect — is the reliable belt-and-suspenders.
    if ((event.type as string) === "catalog.updated" || (event.type as string) === "server.connected") {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[2] === "providers" })
    }

    // Agent status is an instance component even though the event carries the session's location.
    // Notify subscribers before directory routing so Contacts updates whether that folder is open.
    if ((event.type as string) === "agent.status.updated" || (event.type as string) === "agent.status.removed") {
      for (const listener of agentStatusListeners) listener()
    }

    if (directory === "global") {
      applyGlobalEvent({
        event,
        refresh: () => {
          if (recent) return
          // The SSE loop is this ctx's recovery engine: on (re)connect, invalidate every query
          // under this server's scope so the whole data plane refetches (cancelRefetch replaces
          // any in-flight attempt). A bare `bootstrap.refetch()` here was a lost one-shot: when
          // server.connected raced the still-failing boot fetch, TanStack deduped the refetch
          // into the dying attempt and a server that was unreachable at ctx creation stayed
          // frozen on its boot-time error forever (measured live 2026-07-21).
          void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === serverSDK.scope })
        },
      })
      // ⚠️ Both cast, for the reason the `catalog.updated` line above casts: neither is a BUS event.
      // `/api/event` opens with `server.connected` and `/global/event` relays `global.disposed` off
      // the `GlobalBus` when the last instance goes, so the manifest union — which since 2026-09-03
      // is exactly what the bus carries — names neither, while this stream delivers both.
      if ((event.type as string) === "server.connected" || (event.type as string) === "global.disposed") {
        if (recent) return
        // Instance-scoped state first: it has no directory to be queued under, and it is the half
        // that had no sweep at all before 2026-09-04.
        recovery.sweep()
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    // A control-plane folder move (session.next.moved) is stamped with ONE directory, but the OLD
    // folder's store also holds a copy that now carries a stale directory — which leaves the Chats
    // list rendering the chat twice (see event-reducer's moved case). Fan the move to EVERY open
    // directory store so whichever one holds the session folds the new location onto it; the rest no-op.
    if ((event.type as string) === "session.next.moved") {
      for (const entry of Object.values(children.children)) {
        if (!entry) continue
        const [moveStore, moveSetStore] = entry
        applyDirectoryEvent({
          event,
          directory: moveStore.path.directory,
          store: moveStore,
          setStore: moveSetStore,
          push: queue.push,
        })
      }
      return
    }

    let existing = children.children[key]
    if (!existing) {
      // The session RECORD lifecycle (created/updated/deleted) defines list MEMBERSHIP — Chats,
      // sidebars, grouping all render from these stores. Dropping such an event because this
      // directory's store hadn't materialized yet made a fresh chat invisible until its first
      // response (the later session.updated found a store built by navigating into the chat and
      // inserted the record — owner-hit 2026-07-22). Materialize the store and fold; every OTHER
      // event type still requires an existing store, so message-level traffic can't build stores
      // for never-opened folders (the unbounded-growth guard this early return exists for).
      if (!key || (type !== "session.created" && type !== "session.updated" && type !== "session.deleted")) return
      existing = children.ensureChild(directory)
    }
    children.mark(key)
    // A colleague's tab follows its colleague. The RECORD lifecycle is the only signal that says
    // which chat is a colleague's live one, and the archive and its successor arrive as two separate
    // events — so re-evaluate on each of the three rather than on one of them. `followAgentChats`
    // moves a tab only when the id it holds is archived AND that colleague has a live chat, so this
    // is a store read and an early return on every ordinary create.
    if (type === "session.created" || type === "session.updated" || type === "session.deleted")
      notifySessionAgentChats({
        server: ServerConnection.key(serverSDK.server),
        rows: Object.values(session.data.info).flatMap((info) =>
          info
            ? [
                {
                  id: info.id,
                  ...(info.agent === undefined ? {} : { agent: info.agent }),
                  ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
                  archived: info.time.archived !== undefined,
                },
              ]
            : [],
        ),
      })
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      vcsCache: children.vcsCache.get(key),
    })
  })

  onCleanup(() => {
    // This is terminal context destruction, not live eviction: pins protect active work only while
    // this manager is alive and must never retain roots after credential rotation/removal.
    closed = true
    lifetime.abort()
    unregisterMessageRecovery()
    unsub()
    queue.dispose()
    void queryClient.cancelQueries({ predicate: (query) => query.queryKey[0] === serverSDK.scope })
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] === serverSDK.scope })
    children.disposeAll()
  })

  onMount(() => {
    // The hidden-tab fallback this file used to spell out inline now lives in `afterFirstPaint`,
    // along with the two call sites that were missing it.
    cancelEventStart = afterFirstPaint(() => {
      void serverSDK.event.start()
    })
  })

  const projectApi = {
    loadSessions,
    loadChildSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (input: {
      config: Config
      /** Runs after the server accepted the write and before this context starts any follow-up read. */
      onAccepted?: () => void
      /** A credential rotation rebuilds the whole server context, whose bootstrap performs the read. */
      refetch?: boolean
    }) => serverSDK.client.global.config.update({ configInfo: input.config }),
    onSuccess: (_response, input) => {
      settleConfigUpdate(input, () => void bootstrap.refetch())
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
    },
  }))

  return {
    data: globalStore,
    // Which instance this sync context speaks for. Exposed so a consumer that persists something
    // derived from `data`/`child()` can key its storage on the SAME instance those answers came
    // from, instead of reaching for a second source of the scope and hoping the two agree.
    scope: serverSDK.scope,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    updateConfig: (config: Config, options?: ConfigUpdateOptions) =>
      updateConfigMutation.mutateAsync({ config, ...options }),
    removeConfig: createConfigRemover({
      current: () => globalStore.config,
      remove: (paths) => serverSDK.client.v2.config.remove({ configRemoveRequest: { paths } }),
      refresh: () => configQuery.refetch(),
    }),
    // Re-read the global config after something OTHER than `updateConfig` wrote it — the capability
    // probe writes its measured verdict server-side, and without this the panel that just triggered
    // the measurement keeps showing the answer from before it.
    refetchConfig: () => configQuery.refetch(),
    /**
     * A config write being accepted is not evidence that its catalog projection is visible.
     * Settings flows which promise a model was added await this read and inspect the resulting
     * model store before reporting success.
     */
    refetchProviders: async () => {
      const result = await providerQuery.refetch()
      if (result.isError) throw result.error
      return result.data
    },
    project: projectApi,
    session,
    nativeMessages,
    onAgentStatus(listener: () => void) {
      agentStatusListeners.add(listener)
      return () => agentStatusListeners.delete(listener)
    },
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name].status
        await toggleMcp({
          status,
          connect: async () => {
            await sdk.mcp.connect({ name })
          },
          disconnect: async () => {
            await sdk.mcp.disconnect({ name })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
          },
        })
      },
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK, projects: ReturnType<typeof createServerProjects>) {
  const inner = createServerSyncContextInner(serverSDK, projects)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const {
  use: useServerSync,
  provider: ServerSyncProvider,
  context: ServerSyncContext,
} = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      // Programmer invariant (mirrors useServerSDK): ConnectionGate guarantees a server exists
      // before the app subtree renders (dependability P1) — a throw here means a consumer mounted
      // outside the gate.
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
