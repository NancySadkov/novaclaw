import { base64Encode } from "@novaclaw/core/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo, createResource, onCleanup, onMount } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input"
import type { ComposerRemoteChatState } from "@/components/composer"
import { useSettingsDialog } from "@/components/settings-dialog"
import {
  MessengerApiError,
  messengerAccountChats,
  messengerAccounts,
  messengerBindings,
  messengerCreateBinding,
  messengerDrivers,
  messengerRemoveBinding,
} from "@/utils/messenger-api"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useLanguage } from "@/context/language"
import { displayName, errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { switchFeature, switchMode, switchStrict, switchType, type SessionFeatureName, type SessionModeName } from "@/utils/fs-api"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useSessionView } from "@/pages/session/use-session-view"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { legacySessionHref } from "@/utils/session-route"
import { pathKey } from "@/utils/path-key"

export function createPromptInputController(input: {
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
}) {
  const layout = useLayout()
  const language = useLanguage()
  const local = useLocal()
  const providers = useProviders()
  const settings = useSettings()
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const pickDirectory = useDirectoryPicker()
  const navigate = useNavigate()
  const params = useParams<{ dir?: string }>()
  // The per-session facade (ui-arch P5): record/working/scope/key come from ONE place —
  // no hand-picking between sync/serverSync or threading a sessionKey from the route.
  const sessionView = useSessionView(input.sessionID)
  const view = layout.view(sessionView.sessionKey)
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sessionView.directory())))
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sessionView.directory())))

  // 1K: mid-session permission-mode switch — update the local signal AND, when a session is live,
  // tell the server so the MODE_RULES overlay applies from the next turn (create-time uses the
  // signal only). Shared with the Strict switch, which raises the mode to its Bypass floor.
  const selectPermissionMode = (value: Parameters<typeof local.permissionMode.set>[0]) => {
    local.permissionMode.set(value)
    const id = input.sessionID()
    const conn = server.current
    const directory = sessionView.directory()
    if (id && conn && directory)
      void switchMode(conn.http, { directory, sessionID: id, permissionMode: value }).catch((error) =>
        console.error("switchMode failed", error),
      )
  }

  // The per-chat Strict switch (jh.md): this browser's explicit choice wins (it is what we last
  // POSTed — it must not be shadowed by a not-yet-folded record), then the live session record
  // (a fork's copied override, or one set from another client — P2 keeps it folded), then the
  // global Settings → Strict default. Same local-first precedence as the permission-mode droplist.
  const strictGlobal = () =>
    (sync().data.config as { strict?: { enabled?: boolean; attempts?: number; wallMinutes?: number } }).strict ?? {}
  const strictCurrent = () => {
    const record = (
      sessionView.record() as { strict?: { enabled?: boolean; attempts?: number; wallMinutes?: number } } | undefined
    )?.strict
    return local.strict.current() ?? record ?? strictGlobal()
  }

  // The Tuning toggles (introspection · quality · affective · thinkingBudget) — same local-first per
  // feature: this browser's explicit stance, then the session record, then the global config
  // block's `enabled`. The control shows the EFFECTIVE state, so a globally-on feature reads ON
  // here and flipping it writes this chat's explicit off.
  const featuresCurrent = (): Record<SessionFeatureName, boolean> => {
    const record = sessionView.record() as
      | {
          introspection?: boolean
          quality?: boolean
          affective?: boolean
          thinkingBudget?: boolean
          surgicalEdits?: boolean
          askBeforeChanges?: boolean
        }
      | undefined
    const config = sync().data.config as Partial<Record<SessionFeatureName, { enabled?: boolean }>>
    const draft = local.features.current()
    const pick = (feature: SessionFeatureName) =>
      // `thinkingBudget` has no global `{ enabled }` block to fall back on — its instance default IS the
      // model's own budget, which the browser cannot know per-model. Default it ON (enforced) so the
      // control matches the runner's `config.thinkingBudget ?? true`; flipping it writes this chat's off.
      draft?.[feature] ?? record?.[feature] ?? (feature === "thinkingBudget" ? true : config[feature]?.enabled === true)
    return {
      introspection: pick("introspection"),
      quality: pick("quality"),
      affective: pick("affective"),
      thinkingBudget: pick("thinkingBudget"),
      surgicalEdits: pick("surgicalEdits"),
      askBeforeChanges: pick("askBeforeChanges"),
    }
  }

  // The Remote-chat control (messenger-plan §6.2): which messenger chat drives THIS session.
  // Data mirrors the Settings → Messengers pattern — small truthful lists, refetched on any
  // messenger.* bus event (no client-side folding). Live sessions only (edge #15: a draft has no
  // sessionID to bind).
  const serverSDK = useServerSDK()
  const openMessengerSettings = useSettingsDialog("messengers")
  const messengerServer = () => serverSDK().server.http
  const [remoteDrivers] = createResource(() => messengerServer(), messengerDrivers, { initialValue: [] })
  const [remoteAccounts, remoteAccountsRes] = createResource(() => messengerServer(), messengerAccounts, {
    initialValue: [],
  })
  const [remoteBindings, remoteBindingsRes] = createResource(() => messengerServer(), messengerBindings, {
    initialValue: [],
  })
  onMount(() => {
    const unsub = serverSDK().event.listen((e) => {
      if ((e.details.type as string).startsWith("messenger.")) {
        void remoteAccountsRes.refetch()
        void remoteBindingsRes.refetch()
      }
    })
    onCleanup(unsub)
  })
  const remoteDriverName = (driverID: string) => remoteDrivers.latest.find((d) => d.id === driverID)?.name ?? driverID
  const remoteFail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("prompt.remote.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })
  const remoteCurrent = (): ComposerRemoteChatState => {
    const id = input.sessionID()
    const row = id === undefined ? undefined : remoteBindings.latest.find((entry) => entry.binding.sessionID === id)
    const account = row === undefined ? undefined : remoteAccounts.latest.find((a) => a.account.id === row.binding.accountID)
    return {
      bindable: id !== undefined,
      accounts: remoteAccounts.latest
        .filter((entry) => entry.account.enabled)
        .map((entry) => ({
          id: entry.account.id,
          label: entry.account.label,
          driverName: remoteDriverName(entry.account.driverID),
          state: entry.status.state,
        })),
      binding:
        row === undefined
          ? undefined
          : {
              id: row.binding.id,
              driverName: remoteDriverName(account?.account.driverID ?? row.binding.accountID),
              chatTitle: row.chatTitle ?? row.binding.chatID,
              trust: row.binding.trust,
              accountState: account?.status.state ?? "disabled",
            },
      loadChats: (accountID) =>
        messengerAccountChats(messengerServer(), accountID).catch((error: unknown) => ({
          ok: false,
          chats: [],
          reason: error instanceof Error ? error.message : String(error),
        })),
      connect: async (connectInput) => {
        const sessionID = input.sessionID()
        if (sessionID === undefined) return "failed"
        try {
          await messengerCreateBinding(messengerServer(), { ...connectInput, sessionID })
          void remoteBindingsRes.refetch()
          return "ok"
        } catch (error) {
          if (error instanceof MessengerApiError && error.kind === "messenger_chat_bound" && connectInput.steal !== true)
            return "bound"
          remoteFail(error)
          return "failed"
        }
      },
      disconnect: async () => {
        const current = input.sessionID()
        const bound = current === undefined ? undefined : remoteBindings.latest.find((entry) => entry.binding.sessionID === current)
        if (bound === undefined) return
        try {
          await messengerRemoveBinding(messengerServer(), bound.binding.id)
          void remoteBindingsRes.refetch()
        } catch (error) {
          remoteFail(error)
        }
      },
      openSettings: openMessengerSettings,
    }
  }

  // The Mode control (kernel thread type) — same local-first precedence: this browser's explicit
  // choice, then the live session record's type, then the "interactive" default. A "sub-agent"
  // record (viewing a spawned child) displays as interactive; the switch only offers root types.
  const modeCurrent = (): SessionModeName => {
    const record = (sessionView.record() as { type?: string } | undefined)?.type
    const fromRecord =
      record === "interactive" || record === "auto-prompting" || record === "goal-oriented" ? record : undefined
    return local.mode.current() ?? fromRecord ?? "interactive"
  }

  return createMemo<PromptInputControls>(() => ({
    // The visible agent picker (plan/build) is retired — the permission-mode droplist is the one mode
    // control. `available` still feeds the composer's @-mention subagent list.
    agents: {
      available: sync().data.agent,
    },
    model: {
      selection: local.model,
      paid: providers.paid().length > 0,
      loading: agentsQuery.isLoading || providersQuery.isLoading || globalProvidersQuery.isLoading,
    },
    permissionMode: {
      current: local.permissionMode.current(),
      select: selectPermissionMode,
    },
    strict: {
      current: strictCurrent(),
      set: (value) => {
        // The draft signal is the instant UI truth (and the create-time payload); a live session
        // ALSO persists the override server-side so the runner reads it on the next turn.
        local.strict.set(value)
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (id && conn && directory)
          void switchStrict(conn.http, { directory, sessionID: id, strict: value }).catch((error) =>
            console.error("switchStrict failed", error),
          )
        // The Strict harness executes autonomously — the runner's permission floor is Bypass
        // (llm.ts strict gate). Raise the mode with the switch so the toggle just works; the
        // popover says so out loud. Turning Strict off leaves the mode as the user set it.
        if (value.enabled) {
          const mode = local.permissionMode.current()
          if (mode !== "bypass" && mode !== "yolo") selectPermissionMode("bypass")
        }
      },
    },
    // Owner call 2026-07-14: a chat's working folder is changeable while the agent is idle —
    // the session MIGRATES to the picked directory (the control-plane move; children unaffected).
    // Disabled while the agent works: a mid-turn move would yank the cwd out from under tools.
    folder: {
      name: displayName({ worktree: sessionView.directory() }),
      visible: !!input.sessionID(),
      working: sessionView.working(),
      pick: () => {
        const id = input.sessionID()
        const conn = server.current
        if (!id || !conn) return
        pickDirectory({
          server: conn,
          title: language.t("prompt.folder.pick.title"),
          onSelect: (result) => {
            const directory = Array.isArray(result) ? result[0] : result
            if (!directory || directory === sessionView.directory()) return
            void sdk()
              .client.experimental.controlPlane.moveSession({ sessionID: id, destination: { directory } })
              .then((moved) => {
                if (moved.error) throw moved.error
                // P3 view rebind, no reload: the `session.next.moved` event folds the new
                // directory onto the client record (P2), and the target-session route re-derives
                // its directory-scoped contexts from that record reactively. Only the legacy
                // route carries the directory in the URL — re-enter the session at its new home.
                if (params.dir) navigate(legacySessionHref(directory, id))
              })
              .catch((error: unknown) => {
                showToast({
                  title: language.t("prompt.folder.moveFailed"),
                  description: errorMessage(error, language.t("common.requestFailed")),
                })
              })
          },
        })
      },
    },
    features: {
      current: featuresCurrent(),
      set: (feature, enabled) => {
        // The draft signal is the instant UI truth (and the create-time payload); a live session
        // ALSO persists the stance server-side so the runner reads it on the next turn.
        local.features.set({ ...local.features.current(), [feature]: enabled })
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (id && conn && directory)
          void switchFeature(conn.http, { directory, sessionID: id, feature, enabled }).catch((error) =>
            console.error("switchFeature failed", error),
          )
      },
    },
    remote: remoteCurrent(),
    mode: {
      current: modeCurrent(),
      set: (value) => {
        // Same contract as the feature toggles: the draft signal is the instant UI truth (and the
        // create-time payload); a live session ALSO flips the kernel thread type server-side —
        // attendance (out-of-folder deny-fast, Agent Jail confinement) applies immediately.
        local.mode.set(value)
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (id && conn && directory)
          void switchType(conn.http, { directory, sessionID: id, type: value }).catch((error) =>
            console.error("switchType failed", error),
          )
      },
    },
    session: {
      id: input.sessionID(),
      tabs: layout.tabs(sessionView.sessionKey),
      reviewPanel: view.reviewPanel,
    },
    newLayoutDesigns: settings.general.newLayoutDesigns(),
  }))
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const projects = createMemo(() => {
    if (server.list.length <= 1) {
      return search.draftId ? projectServerCtx().projects.list() : layout.projects.list()
    }
    return server.list.flatMap((conn) => {
      const item = { key: ServerConnection.key(conn), name: serverName(conn) }
      return global
        .ensureServerCtx(conn)
        .projects.list()
        .map((project) => ({ ...project, server: item }))
    })
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (search.draftId) {
      if (!conn) return
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
  }))
}
