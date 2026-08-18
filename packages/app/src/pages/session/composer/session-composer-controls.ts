import { createQuery } from "@tanstack/solid-query"
import { useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo, createResource, onCleanup, onMount } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input"
import type { ComposerMakeDefaultState, ComposerRemoteChatState } from "@/components/composer"
import * as ConfigProvenance from "./config-provenance"
import { useSettingsDialog } from "@/components/settings-dialog"
import { projectState, projectWrite } from "@/utils/project-api"
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
import {
  switchFeature,
  switchMode,
  switchStrict,
  switchType,
  type SessionFeatureName,
  type SessionModeName,
} from "@/utils/fs-api"
import { useSync } from "@/context/sync"
import { useSessionView } from "@/pages/session/use-session-view"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"

export function createPromptInputController(input: {
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
}) {
  const layout = useLayout()
  const language = useLanguage()
  const local = useLocal()
  const providers = useProviders()
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const pickDirectory = useDirectoryPicker()
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
  const featureState = () => {
    const record = sessionView.record() as
      | {
          introspection?: boolean
          quality?: boolean
          affective?: boolean
          thinkingBudget?: boolean
          surgicalEdits?: boolean
          askBeforeChanges?: boolean
          safeMode?: boolean
          contextBudget?: boolean
          memory?: boolean
          shortChat?: boolean
        }
      | undefined
    const config = sync().data.config as Partial<Record<SessionFeatureName, { enabled?: boolean }>> & {
      context?: { enabled?: boolean }
    }
    const draft = local.features.current()
    const override = (feature: SessionFeatureName): boolean | undefined =>
      draft && Object.prototype.hasOwnProperty.call(draft, feature) ? draft[feature] : record?.[feature]
    // The kernel's answer, when we have it. It outranks the derived baseline below and loses to this
    // chat's own stance — see `resolvedStances` for what the derivation cannot see.
    const resolvedStance = ConfigProvenance.resolvedStances(resolvedConfig.latest)
    const derived = (feature: SessionFeatureName) =>
      // `thinkingBudget` has no global `{ enabled }` block to fall back on — its instance default IS the
      // model's own budget, which the browser cannot know per-model. Default it ON (enforced) so the
      // control matches the runner's `config.thinkingBudget ?? true`; flipping it writes this chat's off.
      feature === "thinkingBudget"
        ? true
        : feature === "contextBudget"
          ? config.context?.enabled !== false
          : feature === "memory"
            ? (config as { memory?: { enabled?: boolean } }).memory?.enabled !== false
            : feature === "shortChat"
              ? false
              : config[feature]?.enabled === true
    const baseline = (feature: SessionFeatureName) => resolvedStance[feature] ?? derived(feature)
    const overrides: Record<SessionFeatureName, boolean | undefined> = {
      introspection: override("introspection"),
      quality: override("quality"),
      affective: override("affective"),
      thinkingBudget: override("thinkingBudget"),
      surgicalEdits: override("surgicalEdits"),
      askBeforeChanges: override("askBeforeChanges"),
      safeMode: override("safeMode"),
      contextBudget: override("contextBudget"),
      memory: override("memory"),
      shortChat: override("shortChat"),
    }
    const current: Record<SessionFeatureName, boolean> = {
      introspection: overrides.introspection ?? baseline("introspection"),
      quality: overrides.quality ?? baseline("quality"),
      affective: overrides.affective ?? baseline("affective"),
      thinkingBudget: overrides.thinkingBudget ?? baseline("thinkingBudget"),
      surgicalEdits: overrides.surgicalEdits ?? baseline("surgicalEdits"),
      askBeforeChanges: overrides.askBeforeChanges ?? baseline("askBeforeChanges"),
      safeMode: overrides.safeMode ?? baseline("safeMode"),
      contextBudget: overrides.contextBudget ?? baseline("contextBudget"),
      memory: overrides.memory ?? baseline("memory"),
      shortChat: overrides.shortChat ?? baseline("shortChat"),
    }
    return { current, overrides }
  }

  // The Remote-chat control (messenger-plan §6.2): which messenger chat drives THIS session.
  // Data mirrors the Settings → Messengers pattern — small truthful lists, refetched on any
  // messenger.* bus event (no client-side folding). Live sessions only (edge #15: a draft has no
  // sessionID to bind).
  const serverSDK = useServerSDK()
  const openMessengerSettings = useSettingsDialog("messengers")
  const messengerServer = () => serverSDK().server.http
  /**
   * WHERE each switch's value came from, straight from the kernel's own resolution.
   *
   * ⚠️ Asked of the server rather than derived here, and that is the point. The browser already
   * re-derives a BASELINE for each switch (`featureState` below), which is a second copy of a rule
   * the kernel owns; provenance cannot be re-derived at all — a folder's `novaclaw.json` is not
   * something the client can see. `GET /api/session/:id/config` reports the resolution the TURN
   * runs with, including the folder layer, so the panel and the runner cannot disagree.
   *
   * Keyed on the session id, so a draft (no id) simply has no provenance and the panel keeps its
   * previous wording. Failures degrade to `undefined` for the same reason: a line explaining where a
   * value came from is worth having and never worth a toast.
   */
  const [resolvedConfig, resolvedConfigRes] = createResource(
    () => input.sessionID(),
    async (sessionID: string) => {
      const response = await sdk().client.v2.session.config({ sessionID })
      if (response.error) throw response.error
      return response.data?.data
    },
  )

  const featureOrigins = createMemo(() => ConfigProvenance.featureOrigins(resolvedConfig.latest))
  const projectLayer = createMemo(() => ConfigProvenance.projectLayer(resolvedConfig.latest))

  /**
   * The DIRECTORY-keyed project answer, for a chat with no id yet.
   *
   * ⚠️ Only fetched when there is no session, deliberately. Once a session exists the kernel's
   * resolved layer knows strictly more (it carries which switches the file actually supplied), and a
   * second source that could disagree with it is the "two authorities on what is in force" mistake
   * `config-provenance.ts` already warns about — a browser-side re-derivation once produced toggles
   * that were the exact inverse of what the runner resolved.
   *
   * Failures degrade to `undefined`, which `inForceState` renders as "still checking" rather than as
   * an absence: a probe that could not answer is not evidence that the folder is bare.
   */
  // ⚠️ The source is the directory STRING, not an object carrying the connection. A source function
  // returning a fresh `{directory, http}` each read changes identity every time, which is a refetch
  // on every reactive pass — a poll nobody asked for against a route that walks ancestor directories.
  // The connection is read inside the fetcher instead, where it costs nothing.
  const [projectDiscovered] = createResource(
    () => (input.sessionID() === undefined ? sessionView.directory() : undefined),
    (directory: string) => {
      const conn = server.current
      if (!conn) return undefined
      return projectState(conn.http, directory).catch(() => undefined)
    },
  )

  /**
   * "Make Default for this Folder" — write this chat's declared stance into the folder's own
   * `novaclaw.json` (`todo/projects.md`, Tune and Permissions).
   *
   * ⚠️ `undefined` rather than a disabled control when there is no folder or no server: a chip that
   * exists but can never do anything is a worse answer than one that is not there.
   *
   * ⚠️ The panel decides WHICH switches travel (the chat's overrides, so the folder keeps tracking
   * Settings for everything else) and this function only carries them. Splitting it the other way
   * would put the rule in a place the surface explaining the rule cannot see.
   */
  const makeDefaultState = createMemo((): ComposerMakeDefaultState | undefined => {
    const directory = sessionView.directory()
    const conn = server.current
    if (!directory || !conn) return undefined
    return {
      folder: directory,
      governedBy: projectLayer(),
      // A draft has no session id, so `resolvedConfig` — and therefore `projectLayer()` — is empty,
      // and the panel used to fall through to "this folder has no project file yet". That sentence
      // was measured FALSE in folders that had one. This directory-keyed answer is what a draft can
      // honestly know; `inForceState` keeps "no answer yet" distinct from "answered: none".
      discovered: projectDiscovered.latest,
      write: async (features) => {
        try {
          const result = await projectWrite(conn.http, directory, { tune: { features } })
          // The kernel re-reads the file within its cache TTL, but the PANEL's provenance came from
          // a response taken before the write. Without this refetch the section above would keep
          // describing the folder as it was — the surface that explains where a value came from
          // contradicting the receipt printed directly beneath it.
          void resolvedConfigRes.refetch()
          return result.ok
            ? {
                kind: "written" as const,
                file: result.file,
                created: result.created,
                sections: result.sections,
                refused: result.refusedTune,
              }
            : { kind: "refused" as const, file: result.file, reason: result.reason, detail: result.detail }
        } catch (error) {
          // ⚠️ A transport failure is NOT a refusal. "Your project file is broken" and "the request
          // did not land" ask the user for opposite things, and this is the one place they could be
          // flattened together.
          return { kind: "failed" as const, detail: errorMessage(error, language.t("common.requestFailed")) }
        }
      },
    }
  })

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
    const account =
      row === undefined ? undefined : remoteAccounts.latest.find((a) => a.account.id === row.binding.accountID)
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
          if (
            error instanceof MessengerApiError &&
            error.kind === "messenger_chat_bound" &&
            connectInput.steal !== true
          )
            return "bound"
          remoteFail(error)
          return "failed"
        }
      },
      disconnect: async () => {
        const current = input.sessionID()
        const bound =
          current === undefined ? undefined : remoteBindings.latest.find((entry) => entry.binding.sessionID === current)
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
                // its directory-scoped contexts from that record reactively. Nothing to navigate:
                // the canonical route is `/server/<key>/session/<id>`, which carries no directory.
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
      current: featureState().current,
      override: featureState().overrides,
      origin: featureOrigins(),
      project: projectLayer(),
      makeDefault: makeDefaultState(),
      set: (feature, enabled) => {
        // The draft signal is the instant UI truth (and the create-time payload); a live session
        // ALSO persists the stance server-side so the runner reads it on the next turn.
        local.features.set({ ...local.features.current(), [feature]: enabled })
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (id && conn && directory)
          void switchFeature(conn.http, { directory, sessionID: id, feature, enabled })
            // Re-ask who supplied each value. Without this the provenance line keeps describing the
            // resolution from before the flip — the panel explaining a state it no longer shows.
            .then(() => void resolvedConfigRes.refetch())
            .catch((error) => console.error("switchFeature failed", error))
      },
      inherit: (feature) => {
        // An own property with `undefined` is an intentional local reset marker: it bypasses a
        // briefly stale projected record while the null event folds, yet JSON omits it from a new
        // session create body so the sparse inherit-on-undefined contract remains intact.
        local.features.set({ ...local.features.current(), [feature]: undefined })
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (id && conn && directory)
          void switchFeature(conn.http, { directory, sessionID: id, feature, enabled: null })
            // Clearing a stance is exactly when the origin CHANGES — the folder or the instance
            // takes back over — so this refetch is the one that matters most.
            .then(() => void resolvedConfigRes.refetch())
            .catch((error) => console.error("switchFeature reset failed", error))
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
  }))
}

export function createPromptProjectControls() {
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
  // The project picker only renders on the draft page (`/new-session?draftId=…`), so `draftId` is
  // always present and retargeting the draft is the whole job. The fallback exists because
  // `search.draftId` is typed optional, not because a second UI reaches this: it opens a NEW draft
  // in the picked folder, which is exactly what the retired `/:dir/session` route used to do.
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    const draftID = search.draftId
    if (draftID) {
      tabs.updateDraft(draftID, { server: ServerConnection.key(conn), directory: worktree })
      return
    }
    tabs.newDraft({ server: ServerConnection.key(conn), directory: worktree })
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
