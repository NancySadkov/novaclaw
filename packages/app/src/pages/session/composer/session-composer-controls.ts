import { createQuery } from "@tanstack/solid-query"
import { applyOptimistic } from "./optimistic-write"
import { useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo, onCleanup, onMount } from "solid-js"
import { createSettledResource } from "@/utils/settled-resource"
import type { PromptInputControls } from "@/components/prompt-input"
import type { ComposerRemoteChatState } from "@/components/composer"
import * as ConfigProvenance from "./config-provenance"
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

import type { ComposerAgentOption } from "@/components/composer/agent-option"
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
import { switchFeature, switchType, type SessionFeatureName, type SessionModeName } from "@/utils/fs-api"
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
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  // The per-session facade (ui-arch P5): record/working/scope/key come from ONE place —
  // no hand-picking between sync/serverSync or threading a sessionKey from the route.
  const sessionView = useSessionView(input.sessionID)
  const view = layout.view(sessionView.sessionKey)
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sessionView.directory())))
  // 🔴 The ROSTER's own loader, not `agentsQuery`. The two answer different questions and return
  // different shapes: `queryOptions.agents` reads `sdk.app.agents()` — the app-level list, which
  // carries no display NAME — while the roster reads `v2.agent.list`. Measured 2026-08-21: the chip
  // rendered the id `zenon` where every other surface says `Zenon`. One roster, one loader.
  //
  // 🔴 The server context's ONE shared roster, like every other surface. It used to be a THIRD
  // `listAgents` resource with no `.catch`, and a `createResource` read from an eager memo rethrows —
  // so one failed roster fetch replaced the entire UI with the root error page, for a chip whose only
  // job is to show a name. `ctx.agents` carries that catch, degrading to `[]` (the chip then renders
  // the id, which is what this call site already falls back to for a missing row).
  //
  // ⚠️ It ALSO makes a rename visible. The composer's Tune dialog refetches this roster on save; when
  // the chip owned a private resource, nothing refreshed it and the new name never appeared — the
  // rename read as a failed save.
  const rosterCtx = createMemo(() => {
    const conn = server.current
    return conn ? global.ensureServerCtx(conn) : undefined
  })
  const rosterAgents = () => rosterCtx()?.agents.list()
  /** Whose chat this is, as the chip needs it: the name a person sees, and where they work. */
  const rosterOption = createMemo<ComposerAgentOption | undefined>(() => {
    const id = (sessionView.record() as { agent?: string } | undefined)?.agent
    if (!id) return undefined
    const row = (rosterAgents() ?? []).find((agent) => agent.id === id)
    const shortChat = row?.config?.["shortChat"] === true
    const configured = shortChat ? undefined : row?.config?.["directory"]
    const folder = typeof configured === "string" && configured.trim() !== "" ? configured : undefined
    return {
      id,
      name: row?.name?.trim() || id,
      ...(row?.avatar ? { avatar: row.avatar } : {}),
      folder: folder ?? language.t("agentConfig.folderScratch"),
      ownScratch: folder === undefined,
      shortChat,
    }
  })
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sessionView.directory())))

  // 1K: mid-session permission-mode switch — update the local signal AND, when a session is live,
  // tell the server so the MODE_RULES overlay applies from the next turn (create-time uses the
  // signal only). Shared with the Strict switch, which raises the mode to its Bypass floor.
  /**
   * 🔴 **NC-REL-035 — an optimistic control write that FAILED must not stay on screen.**
   *
   * Every switch here wrote its value into persisted browser state FIRST, then fired the server
   * request, and handled failure with `console.error` alone. So a refused write left the UI showing
   * one posture while the kernel kept the other — and for the permission mode and the Strict switch
   * that is a SAFETY posture: the composer says "plan" while the session is still running under the
   * old permissions, and nothing anywhere says otherwise.
   *
   * ⚠️ Revert AND say so. Reverting silently would be its own lie — the control would appear to
   * spring back for no reason — and this codebase's standing rule is that a failed mutation never
   * reports success. The toast names which control went back.
   */
  /**
   * Set a control optimistically and put it back if the server refuses. `applyOptimistic` owns the
   * ORDER (apply, then revert only on rejection) and carries the reasoning and the tests; this adds
   * the sentence the user reads.
   */
  const optimistic = <T>(input: {
    readonly set: (value: T) => void
    readonly previous: T
    readonly next: T
    readonly write: Promise<unknown>
    readonly control: string
  }) =>
    void applyOptimistic({
      set: input.set,
      previous: input.previous,
      next: input.next,
      write: input.write,
      onReverted: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: `${language.t("session.control.reverted", { control: input.control })} (${errorMessage(error, language.t("common.requestFailed"))})`,
        }),
    })

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
    //
    // ⚠️ For a DRAFT that answer comes from the folder's fold rather than from a session resolution,
    // and it is the same kind of thing: what the chat this button creates will actually start with.
    // Without it the switches state the instance's stance under a sentence naming the folder's file.
    const resolvedStance = kernelStances()
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
    // ⚠️ The precedence itself lives in `switchStance`, so the ORDER the panel renders is the same
    // expression a test can assert — the whole surface exists to agree with the runner, and the
    // agreement IS the order.
    const stance = (feature: SessionFeatureName) =>
      ConfigProvenance.switchStance({
        own: override(feature),
        kernel: resolvedStance[feature],
        instance: derived(feature),
      })
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
      introspection: stance("introspection"),
      quality: stance("quality"),
      affective: stance("affective"),
      thinkingBudget: stance("thinkingBudget"),
      surgicalEdits: stance("surgicalEdits"),
      askBeforeChanges: stance("askBeforeChanges"),
      safeMode: stance("safeMode"),
      contextBudget: stance("contextBudget"),
      memory: stance("memory"),
      shortChat: stance("shortChat"),
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
  // 🗑️ A directory-keyed `projectDiscovered` resource stood here, reading `GET /api/project` for a
  // DRAFT so the Tuning panel could render the folder's own stance where a session-less chat had none.
  // Both the route and the declaration are retired (owner, 2026-09-16): a draft has nothing beneath it
  // now, so the panel's provenance is the instance's and the probe has no question to ask.

  /**
   * WHERE each switch's value came from, straight from the kernel's own resolution.  /**
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
  /** The agent the SESSION carries, per the record the app already holds. Undefined for a draft. */
  const sessionAgent = () => {
    const value = (sessionView.record() as { agent?: unknown } | undefined)?.agent
    return typeof value === "string" && value !== "" ? value : undefined
  }

  const [resolvedConfig, resolvedConfigRes] = createSettledResource(
    () => input.sessionID(),
    async (sessionID: string) => {
      const response = await sdk().client.v2.session.config({ sessionID })
      if (response.error) throw response.error
      return response.data?.data
    },
  )

  // 🗑️ `featureOrigins` used to branch on `isDraft()`, with a `projectLayer` beside it and a
  // `draftStances` fold for the folder's tune. All three read the retired route and all three
  // collapse to the same answer now: the kernel's own resolution of THIS session, whose provenance is
  // the instance's or this chat's.
  const isDraft = () => input.sessionID() === undefined
  const featureOrigins = createMemo(() => ConfigProvenance.featureOrigins(resolvedConfig()))
  /** The kernel's stance per switch — the session's own resolution. */
  const kernelStances = () => ConfigProvenance.resolvedStances(resolvedConfig())
  // 🔴 All three carried `initialValue: []`, which is what made a refused `/api/messenger/account`
  // replace the whole application: `initialValue` sets `resolved`, and `.latest`'s getter re-throws
  // the fetcher's error on the `resolved` branch — so the spelling that READ like the fallback was
  // the one that threw, from an eager memo outside the transcript's ErrorBoundary. It also erased
  // the distinction this section needs most: an empty account list and an unanswered question are
  // different facts, and only one of them may be rendered as "No messenger accounts yet".
  const [remoteDrivers] = createSettledResource(() => messengerServer(), messengerDrivers)
  const [remoteAccounts, remoteAccountsRes] = createSettledResource(
    () => [messengerServer(), (sessionView.record() as { agent?: string } | undefined)?.agent ?? "nova"] as const,
    ([http, agentID]) => messengerAccounts(http, agentID),
  )
  const [remoteBindings, remoteBindingsRes] = createSettledResource(() => messengerServer(), messengerBindings)
  onMount(() => {
    const unsub = serverSDK().event.listen((e) => {
      if ((e.details.type as string).startsWith("messenger.")) {
        void remoteAccountsRes.refetch()
        void remoteBindingsRes.refetch()
      }
    })
    onCleanup(unsub)
  })
  const remoteDriverName = (driverID: string) =>
    (remoteDrivers() ?? []).find((d) => d.id === driverID)?.name ?? driverID
  const remoteFail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("prompt.remote.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })
  /**
   * Whether the messenger lists could be READ at all.
   *
   * ⚠️ This exists so the section's empty state and its outage stay two different facts. The panel
   * renders `accounts.length === 0` as *"No messenger accounts yet — add one in Settings"*, which is
   * a false sentence when the request never landed — and the same is true of an absent `binding`,
   * which would claim this chat drives nothing when we simply could not ask. `RemoteChatSection`
   * branches on this reading before it reaches either sentence.
   *
   * `remoteDrivers` is deliberately NOT counted: a missing driver list costs a display NAME, and
   * `remoteDriverName` already falls back to the id, so its failure is a degradation and not a lie.
   */
  const remoteAvailability = (): "ready" | "loading" | "failed" => {
    if (remoteAccounts.failed || remoteBindings.failed) return "failed"
    if (remoteAccounts.loading || remoteBindings.loading) return "loading"
    return "ready"
  }
  // `availability` is part of `ComposerRemoteChatState` itself now — the panel reads it, so the
  // intersection that used to widen the return type here is gone and the field is checked.
  const remoteCurrent = (): ComposerRemoteChatState => {
    const id = input.sessionID()
    const accountRows = remoteAccounts() ?? []
    const bindingRows = remoteBindings() ?? []
    const row = id === undefined ? undefined : bindingRows.find((entry) => entry.binding.sessionID === id)
    const account = row === undefined ? undefined : accountRows.find((a) => a.account.id === row.binding.accountID)
    return {
      availability: remoteAvailability(),
      bindable: id !== undefined,
      accounts: accountRows
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
          current === undefined
            ? undefined
            : (remoteBindings() ?? []).find((entry) => entry.binding.sessionID === current)
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
    agents: {
      // WHOSE chat this is. The SESSION's own agent first, and the local pick only as a fallback
      // for a draft that has no session yet.
      //
      // 🔴 The order is the whole fix. `local.agent` is what this BROWSER last picked and defaults
      // to `build`; under the roster every chat is created bound to a colleague, so trusting the
      // local pick made the composer chip — and the config Tune opened — name the wrong one.
      // Measured 2026-08-21: opening Plan from the roster produced Plan's session server-side while
      // the composer said "Build" and Tune opened BUILD's profile on PLAN's chat.
      //
      // ⚠️ And the obvious third source is still wrong: `session.config`'s `resolved` bag does NOT
      // carry the agent (it resolves `type`, `priority`, `responder`, `permissionMode`), which is
      // what sent this to the local pick in the first place.
      current: sessionAgent() ?? local.agent.current()?.name,
    },
    model: {
      selection: local.model,
      loading: agentsQuery.isLoading || providersQuery.isLoading || globalProvidersQuery.isLoading,
    },
    // 🔴 WHOSE chat this is — replacing the folder chip that stood here (owner, 2026-08-21).
    //
    // The old chip MIGRATED the session to another directory, and that is now the wrong affordance:
    // a chat's folder IS its colleague's folder, so moving one chat elsewhere would leave the two
    // disagreeing about where that colleague works. Reassigning the colleague is the move that exists
    // now, it happens in Contacts, and it tells the colleague (`AgentReassignment`).
    //
    // ⚠️ IDENTITY, not a picker. A colleague has one chat ("a single compactable chat per agent"), so
    // switching agent mid-conversation would hand this transcript to a different officer — the
    // confusion the roster removed. The chip says who; the roster is where you choose.
    agent: {
      visible: !!input.sessionID(),
      option: rosterOption(),
    },
    features: {
      current: featureState().current,
      override: featureState().overrides,
      origin: featureOrigins(),
      set: (feature, enabled) => {
        // The draft signal is the instant UI truth (and the create-time payload); a live session
        // ALSO persists the stance server-side so the runner reads it on the next turn.
        const previousFeatures = local.features.current()
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (!id || !conn || !directory) {
          local.features.set({ ...previousFeatures, [feature]: enabled })
          return
        }
        optimistic({
          set: local.features.set,
          previous: previousFeatures,
          next: { ...previousFeatures, [feature]: enabled },
          // ⚠️ The refetch rides the WRITE, so a refusal reverts and never refetches: re-asking who
          // supplied each value after a failed flip would describe a resolution that did not happen.
          // Without it the provenance line keeps describing the state from before a flip that DID.
          write: switchFeature(conn.http, { directory, sessionID: id, feature, enabled }).then(
            () => void resolvedConfigRes.refetch(),
          ),
          control: feature,
        })
      },
      inherit: (feature) => {
        // An own property with `undefined` is an intentional local reset marker: it bypasses a
        // briefly stale projected record while the null event folds, yet JSON omits it from a new
        // session create body so the sparse inherit-on-undefined contract remains intact.
        const beforeReset = local.features.current()
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (!id || !conn || !directory) {
          local.features.set({ ...beforeReset, [feature]: undefined })
          return
        }
        optimistic({
          set: local.features.set,
          previous: beforeReset,
          next: { ...beforeReset, [feature]: undefined },
          // Clearing a stance is exactly when the origin CHANGES — the folder or the instance takes
          // back over — so this refetch is the one that matters most, and equally the one that must
          // NOT run when the clear was refused.
          write: switchFeature(conn.http, { directory, sessionID: id, feature, enabled: null }).then(
            () => void resolvedConfigRes.refetch(),
          ),
          control: feature,
        })
      },
    },
    remote: remoteCurrent(),
    mode: {
      current: modeCurrent(),
      set: (value) => {
        // Same contract as the feature toggles: the draft signal is the instant UI truth (and the
        // create-time payload); a live session ALSO flips the kernel thread type server-side —
        // attendance (out-of-folder deny-fast, Agent Jail confinement) applies immediately.
        const previousMode = local.mode.current()
        const id = input.sessionID()
        const conn = server.current
        const directory = sessionView.directory()
        if (!id || !conn || !directory) local.mode.set(value)
        else
          optimistic({
            set: local.mode.set,
            previous: previousMode,
            next: value,
            write: switchType(conn.http, { directory, sessionID: id, type: value }),
            control: language.t("prompt.mode.control"),
          })
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
