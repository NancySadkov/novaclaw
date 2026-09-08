import { createStore, reconcile } from "solid-js/store"
import { type Accessor, batch, createEffect, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { useParams, useSearchParams } from "@solidjs/router"
import { createSimpleContext } from "@novaclaw/ui/context"
import type { ServerSDK } from "./server-sdk"
import type { ServerSync } from "./server-sync"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { base64Encode } from "@novaclaw/core/util/encode"
import { sessionErrorDisplay, sessionErrorHeadline, sessionErrorLike } from "@novaclaw/core/session/session-error"
import { decode64 } from "@/utils/base64"
import { EventSessionError } from "@novaclaw/sdk/v2"
import { Persist, persisted } from "@/utils/persist"
import { playSoundById } from "@/utils/sound"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"
import { sessionExecutions } from "@/utils/session-execution-api"
import { terminalAttention } from "@/apps/roster-live"
import { withTransientOwner } from "@/utils/transient-owner"
import { flushToastHistory, subscribeToastHistory, type ToastHistoryEntry } from "@/utils/toast-history"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: unknown
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error: EventSessionError["properties"]["error"]
}

type ToastNotification = NotificationBase &
  ToastHistoryEntry & {
    type: "toast"
  }

export type Notification = TurnCompleteNotification | ErrorNotification | ToastNotification

// Stable empty results for the graceful-degradation path (a not-yet-connected server).
const NO_NOTIFICATIONS: Notification[] = []
const NO_SESSION_IDS: string[] = []

type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

type ExecutionNotificationMetadata = {
  executionAttemptID: string
  terminalAttention: "complete" | "recovery"
}

const isExecutionNotificationMetadata = (value: unknown): value is ExecutionNotificationMetadata => {
  if (typeof value !== "object" || value === null) return false
  const metadata = value as Record<string, unknown>
  return (
    typeof metadata["executionAttemptID"] === "string" &&
    (metadata["terminalAttention"] === "complete" || metadata["terminalAttention"] === "recovery")
  )
}

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function createNotificationIndex(): NotificationIndex {
  return {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }
}

function buildNotificationIndex(list: Notification[]) {
  const index = createNotificationIndex()

  list.forEach((notification) => {
    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1
        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1
        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

export const {
  use: useNotification,
  provider: NotificationProvider,
  context: NotificationContext,
} = createSimpleContext({
  name: "Notification",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()
    const owner = getOwner()
    const states = new Map<ServerScope, { dispose: () => void; state: NotificationState }>()

    const activeServer = createMemo(() => {
      if (params.serverKey) return requireServerKey(params.serverKey)
      if (search.draftId) {
        const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
        if (draft) return draft.server
      }
      return server.key
    })
    const activeDirectory = createMemo(() => decode64(params.dir))
    const activeSession = createMemo(() => params.id)

    const ensure = (conn: ServerConnection.Any) => {
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing) return existing.state
      const root = createRoot(
        (dispose) => ({
          dispose,
          state: createServerNotificationState({
            sdk: ctx.sdk,
            sync: ctx.sync,
            active: () => server.scope(activeServer()) === ctx.sdk.scope,
            directory: activeDirectory,
            sessionID: activeSession,
            platform,
            settings,
            language,
          }),
        }),
        owner ?? undefined,
      )
      states.set(ctx.sdk.scope, root)
      return root.state
    }

    // Notification state follows the selected instance. Keeping one listener/store per configured
    // connection would defeat Global's demand-created server contexts by starting every inactive
    // instance's SSE stream and persistence work at boot. Selecting an instance reads its persisted
    // notifications through `selected()` and creates its state on demand.
    createEffect(() => {
      const scopes = new Set(global.servers.list().map((conn) => server.scope(ServerConnection.key(conn))))
      states.forEach((value, scope) => {
        if (scopes.has(scope)) return
        value.dispose()
        states.delete(scope)
      })
    })

    onCleanup(() => states.forEach((value) => value.dispose()))

    // A server-scoped notification state exists only once its connection is registered in
    // global.servers.list(). If the requested key points at a not-yet-connected instance (a fresh
    // page-load / deep-link of /server/{key}/session/{id} before the connection settles, or a
    // home-launcher tile for a server that is still reconnecting), DEGRADE to undefined instead of
    // throwing — the reactive list() re-runs these reads, so the UI recovers when the instance comes
    // online. A reconnecting server must never fault the app. Both selected() and every external
    // caller of ensureServerState ride this single guard, so the missing-server case has no path to
    // the UI as a raw error.
    const serverState = (key: ServerConnection.Key): NotificationState | undefined => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) return undefined
      return ensure(conn)
    }
    const selected = (): NotificationState | undefined => serverState(activeServer())
    const unsubscribeToastHistory = subscribeToastHistory((entry) => {
      const state = selected()
      if (!state?.ready()) return false
      state.appendToast(entry)
      return true
    })
    createEffect(() => {
      if (selected()?.ready()) flushToastHistory()
    })
    onCleanup(unsubscribeToastHistory)

    return {
      ready: () => selected()?.ready() ?? false,
      ensureServerState: serverState,
      session: {
        all: (session: string) => selected()?.session.all(session) ?? NO_NOTIFICATIONS,
        unseen: (session: string) => selected()?.session.unseen(session) ?? NO_NOTIFICATIONS,
        unseenCount: (session: string) => selected()?.session.unseenCount(session) ?? 0,
        unseenHasError: (session: string) => selected()?.session.unseenHasError(session) ?? false,
        unseenSessionIds: () => selected()?.session.unseenSessionIds() ?? NO_SESSION_IDS,
        markViewed: (session: string) => selected()?.session.markViewed(session),
      },
      project: {
        all: (directory: string) => selected()?.project.all(directory) ?? NO_NOTIFICATIONS,
        unseen: (directory: string) => selected()?.project.unseen(directory) ?? NO_NOTIFICATIONS,
        unseenCount: (directory: string) => selected()?.project.unseenCount(directory) ?? 0,
        unseenHasError: (directory: string) => selected()?.project.unseenHasError(directory) ?? false,
        markViewed: (directory: string) => selected()?.project.markViewed(directory),
      },
      history: {
        recent: () => selected()?.history.recent() ?? NO_NOTIFICATIONS,
      },
    }
  },
})

type NotificationState = ReturnType<typeof createServerNotificationState>

function createServerNotificationState(input: {
  sdk: ServerSDK
  sync: ServerSync
  active: Accessor<boolean>
  directory: Accessor<string | undefined>
  sessionID: Accessor<string | undefined>
  platform: ReturnType<typeof usePlatform>
  settings: ReturnType<typeof useSettings>
  language: ReturnType<typeof useLanguage>
}) {
  const serverSDK = () => input.sdk
  const serverSync = () => input.sync
  const platform = input.platform
  const settings = input.settings
  const language = input.language

  const empty: Notification[] = []

  const currentDirectory = input.directory
  const currentSession = input.sessionID

  const [store, setStore, _, ready] = persisted(
    Persist.serverGlobal(serverSDK().scope, "notification", ["notification.v1"]),
    createStore({
      list: [] as Notification[],
    }),
  )
  const [index, setIndex] = createStore<NotificationIndex>(buildNotificationIndex(store.list))

  const meta = { pruned: false, disposed: false }

  const updateUnseen = (scope: "session" | "project", key: string, unseen: Notification[]) => {
    setIndex(scope, "unseen", key, unseen)
    setIndex(scope, "unseenCount", key, unseen.length)
    setIndex(
      scope,
      "unseenHasError",
      key,
      unseen.some((notification) => notification.type === "error"),
    )
  }

  const appendToIndex = (notification: Notification) => {
    if (notification.session) {
      setIndex("session", "all", notification.session, (all = []) => [...all, notification])
      if (!notification.viewed) {
        setIndex("session", "unseen", notification.session, (unseen = []) => [...unseen, notification])
        setIndex("session", "unseenCount", notification.session, (count = 0) => count + 1)
        if (notification.type === "error") setIndex("session", "unseenHasError", notification.session, true)
      }
    }

    if (notification.directory) {
      setIndex("project", "all", notification.directory, (all = []) => [...all, notification])
      if (!notification.viewed) {
        setIndex("project", "unseen", notification.directory, (unseen = []) => [...unseen, notification])
        setIndex("project", "unseenCount", notification.directory, (count = 0) => count + 1)
        if (notification.type === "error") setIndex("project", "unseenHasError", notification.directory, true)
      }
    }
  }

  const removeFromIndex = (notification: Notification) => {
    if (notification.session) {
      setIndex("session", "all", notification.session, (all = []) => all.filter((n) => n !== notification))
      if (!notification.viewed) {
        const unseen = (index.session.unseen[notification.session] ?? empty).filter((n) => n !== notification)
        updateUnseen("session", notification.session, unseen)
      }
    }

    if (notification.directory) {
      setIndex("project", "all", notification.directory, (all = []) => all.filter((n) => n !== notification))
      if (!notification.viewed) {
        const unseen = (index.project.unseen[notification.directory] ?? empty).filter((n) => n !== notification)
        updateUnseen("project", notification.directory, unseen)
      }
    }
  }

  createEffect(() => {
    if (!ready()) return
    if (meta.pruned) return
    meta.pruned = true
    const list = pruneNotifications(store.list)
    batch(() => {
      setStore("list", list)
      setIndex(reconcile(buildNotificationIndex(list), { merge: false }))
    })
  })

  const append = (notification: Notification) => {
    const list = pruneNotifications([...store.list, notification])
    const keep = new Set(list)
    const removed = store.list.filter((n) => !keep.has(n))

    batch(() => {
      if (keep.has(notification)) appendToIndex(notification)
      removed.forEach((n) => removeFromIndex(n))
      setStore("list", list)
    })
  }

  const appendToast = (entry: ToastHistoryEntry) => append({ ...entry, type: "toast", viewed: true })

  // 🔴 This runs from the SSE flush (`event.listen` -> setTimeout), where NO Solid owner is
  // current. `ensureDirSyncContext` is refcounted and registers its DECREMENT with `onCleanup`, so
  // called from here it used to increment a count nothing could ever bring back down: every
  // idle/exited status and every session error for a directory pinned one more reference, and the
  // real UI consumer unmounting then decremented to N instead of 0 — so `disableMcp(dir)` never
  // ran and the directory's sync context was never released. A transient owner disposed when the
  // lookup settles is the only owner this call site can have; the tab strip's prefetch reached the
  // same conclusion independently, which is why this is now one named helper rather than two.
  const lookup = (directory: string, sessionID?: string) => {
    if (!sessionID) return Promise.resolve(undefined)
    return withTransientOwner(async () => {
      // Acquired in the SYNCHRONOUS prefix, before any await — that is what the owner covers.
      const sync = serverSync().ensureDirSyncContext(directory)
      const session = sync.session.get(sessionID)
      if (session) return session
      return sync.session
        .sync(sessionID)
        .then(() => sync.session.get(sessionID))
        .catch(() => undefined)
    }).catch(() => undefined)
  }

  const viewedInCurrentSession = (directory: string, sessionID?: string) => {
    if (!input.active()) return false
    const activeDirectory = currentDirectory()
    const activeSession = currentSession()
    if (!activeSession) return false
    if (!sessionID) return false
    if (activeDirectory && directory !== activeDirectory) return false
    return sessionID === activeSession
  }

  const handleSessionStatus = (
    directory: string,
    event: { properties: { sessionID?: string; status?: { type?: string } } },
    time: number,
  ) => {
    const sessionID = event.properties.sessionID
    const lifecycle = event.properties.status?.type
    if (lifecycle !== "idle" && lifecycle !== "exited") return

    // `session.status` owns whether the process is running; the execution ledger owns HOW it
    // stopped. The runner can publish an early idle before post-run maintenance and before the
    // lease settles, so an idle event by itself is not completion evidence. The host publishes the
    // terminal idle again after it has durably settled/paused the attempt.
    void lookup(directory, sessionID).then(async (session) => {
      if (meta.disposed) return
      if (!session) return
      // A child completes as part of its visible root's work. The root's own terminal transition
      // will carry the one notification; a child must never appear as a second colleague.
      if (session.parentID) return

      const executions = await sessionExecutions(serverSDK().server.http, sessionID).catch(() => [])
      if (meta.disposed) return
      const execution = executions.find((item) => item.sessionID === sessionID)
      const attention = terminalAttention({ lifecycle, execution: execution?.state })
      if (attention === undefined) return
      // The runner's early idle and the host's post-settlement idle can race this async lookup. If
      // the ledger settles between event receipt and this read, BOTH handlers see the same terminal
      // attempt. Keying the indication by its durable attempt id makes that one completion/recovery
      // fact produce one notification, regardless of which lifecycle delivery observed it first.
      if (
        execution &&
        store.list.some(
          (notification) =>
            notification.session === sessionID &&
            isExecutionNotificationMetadata(notification.metadata) &&
            notification.metadata.executionAttemptID === execution.attemptID &&
            notification.metadata.terminalAttention === attention,
        )
      )
        return

      const metadata = execution
        ? ({
            executionAttemptID: execution.attemptID,
            terminalAttention: attention,
          } satisfies ExecutionNotificationMetadata)
        : undefined

      const href = `/${base64Encode(directory)}/session/${sessionID}`
      if (attention === "recovery") {
        if (settings.sounds.errorsEnabled()) void playSoundById(settings.sounds.errors())

        const detail =
          execution?.failureDetail?.trim() || language.t("notification.session.recovery.fallbackDescription")
        append({
          directory,
          time,
          viewed: viewedInCurrentSession(directory, sessionID),
          type: "error",
          session: sessionID,
          error: { message: detail },
          metadata,
        })
        if (settings.notifications.errors()) {
          void platform.notify(language.t("notification.session.recovery.title"), detail, href)
        }
        return
      }

      if (settings.sounds.agentEnabled()) {
        void playSoundById(settings.sounds.agent())
      }

      append({
        directory,
        time,
        viewed: viewedInCurrentSession(directory, sessionID),
        type: "turn-complete",
        session: sessionID,
        metadata,
      })

      if (settings.notifications.agent()) {
        void platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, href)
      }
    })
  }

  const handleSessionError = (
    directory: string,
    event: { properties: { sessionID?: string; error?: EventSessionError["properties"]["error"] } },
    time: number,
  ) => {
    const sessionID = event.properties.sessionID
    void lookup(directory, sessionID).then((session) => {
      if (meta.disposed) return
      if (session?.parentID) return

      if (settings.sounds.errorsEnabled()) {
        void playSoundById(settings.sounds.errors())
      }

      const error = "error" in event.properties ? event.properties.error : undefined
      append({
        directory,
        time,
        viewed: viewedInCurrentSession(directory, sessionID),
        type: "error",
        session: sessionID ?? "global",
        error,
      })
      // ⚠️ This used to read `session?.title ?? (typeof error === "string" ? error : fallback)` —
      // a THIRD formatter for session faults, and one that never fired: the record-level
      // `session.error` event declares its payload `Schema.Unknown`, and its one producer
      // (`novaclaw/src/skill/index.ts`) publishes a `NamedError` OBJECT — `{ name, data: { message } }`,
      // never a bare string. So the only shape ever sent fell straight through to "An error
      // occurred", and a skill that failed to parse told the user nothing about itself. That is
      // ruling 2's *an unavailable subsystem names itself instead of rendering empty*, and
      // `sessionErrorLike` is where that shape is now understood, once, for every reader.
      //
      // The FAULT now leads and the chat title is the fallback, not the other way round: the title
      // answers "which chat" — which the notification's own href and the launcher's per-session
      // error badge already answer — while nothing else answers "what broke".
      const fault = sessionErrorLike(error)
      const description =
        (fault === undefined ? undefined : sessionErrorHeadline(sessionErrorDisplay(fault), language.t)) ??
        session?.title ??
        language.t("notification.session.error.fallbackDescription")
      const href = sessionID ? `/${base64Encode(directory)}/session/${sessionID}` : `/${base64Encode(directory)}`
      if (settings.notifications.errors()) {
        void platform.notify(language.t("notification.session.error.title"), description, href)
      }
    })
  }

  // A deleted session must take its notifications with it — a lingering unseen entry for a chat
  // that no longer exists reads as a phantom on every attention aggregate (the launcher badge,
  // unseenSessionIds) with no way left to mark it viewed. Purge list + index in one batch.
  const purgeSession = (sessionID: string) => {
    const removed = store.list.filter((notification) => notification.session === sessionID)
    if (!removed.length) return
    batch(() => {
      removed.forEach((notification) => removeFromIndex(notification))
      setStore("list", (list) => list.filter((notification) => notification.session !== sessionID))
    })
  }

  const unsub = serverSDK().event.listen((e) => {
    const event = e.details
    if (event.type === "session.deleted") {
      const sessionID = event.properties.info?.id
      if (sessionID) purgeSession(sessionID)
      return
    }
    if (event.type !== "session.status" && event.type !== "session.error") return

    const directory = e.name
    const time = Date.now()
    if (event.type === "session.status") {
      handleSessionStatus(directory, event, time)
      return
    }
    handleSessionError(directory, event, time)
  })
  onCleanup(() => {
    meta.disposed = true
    unsub()
  })

  return {
    ready,
    session: {
      all(session: string) {
        return index.session.all[session] ?? empty
      },
      unseen(session: string) {
        return index.session.unseen[session] ?? empty
      },
      unseenCount(session: string) {
        return index.session.unseenCount[session] ?? 0
      },
      unseenHasError(session: string) {
        return index.session.unseenHasError[session] ?? false
      },
      // Sessions with unseen notifications — the aggregate the launcher badge / attention
      // surfaces need (per-key accessors can't enumerate). Reactive via the index store.
      unseenSessionIds() {
        return Object.keys(index.session.unseenCount).filter((session) => (index.session.unseenCount[session] ?? 0) > 0)
      },
      markViewed(session: string) {
        const unseen = index.session.unseen[session] ?? empty
        if (!unseen.length) return

        const projects = [
          ...new Set(unseen.flatMap((notification) => (notification.directory ? [notification.directory] : []))),
        ]
        batch(() => {
          setStore("list", (n) => n.session === session && !n.viewed, "viewed", true)
          updateUnseen("session", session, [])
          projects.forEach((directory) => {
            const next = (index.project.unseen[directory] ?? empty).filter(
              (notification) => notification.session !== session,
            )
            updateUnseen("project", directory, next)
          })
        })
      },
    },
    project: {
      all(directory: string) {
        return index.project.all[directory] ?? empty
      },
      unseen(directory: string) {
        return index.project.unseen[directory] ?? empty
      },
      unseenCount(directory: string) {
        return index.project.unseenCount[directory] ?? 0
      },
      unseenHasError(directory: string) {
        return index.project.unseenHasError[directory] ?? false
      },
      markViewed(directory: string) {
        const unseen = index.project.unseen[directory] ?? empty
        if (!unseen.length) return

        const sessions = [
          ...new Set(unseen.flatMap((notification) => (notification.session ? [notification.session] : []))),
        ]
        batch(() => {
          setStore("list", (n) => n.directory === directory && !n.viewed, "viewed", true)
          updateUnseen("project", directory, [])
          sessions.forEach((session) => {
            const next = (index.session.unseen[session] ?? empty).filter(
              (notification) => notification.directory !== directory,
            )
            updateUnseen("session", session, next)
          })
        })
      },
    },
    appendToast,
    history: {
      recent() {
        return store.list.slice(-50).reverse()
      },
    },
  }
}
