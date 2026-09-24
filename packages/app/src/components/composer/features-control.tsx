import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { Icon } from "@novaclaw/ui/v2/icon"
import { Switch as SwitchToggle } from "@novaclaw/ui/v2/switch-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLocation, useNavigate } from "@solidjs/router"
import { ControlScope } from "@/components/control-scope"
import { SettingsExplainV2 } from "@/components/settings-v2/explain"
import { useLanguage } from "@/context/language"
import { pathKey } from "@/utils/path-key"


export type ComposerFeature =
  | "introspection"
  | "quality"
  | "affective"
  | "thinkingBudget"
  | "surgicalEdits"
  | "askBeforeChanges"
  | "safeMode"
  | "contextBudget"
  | "memory"
  | "shortChat"
export type ComposerMode = "interactive" | "auto-prompting" | "goal-oriented"

export type ComposerFeatureOrigin =
  | { kind: "session" }
  | { kind: "officer" }
  | { kind: "instance" }

export type ComposerRemoteTrust = "operator" | "client" | "audience"

export type ComposerRemoteAccount = {
  id: string
  label: string
  driverName: string
  state: string // AccountStatus["state"] — drives the status dot
}

export type ComposerRemoteBinding = {
  id: string
  driverName: string
  chatTitle: string
  trust: ComposerRemoteTrust
  accountState: string
}

export type ComposerRemoteChatChoice = { chatID: string; title: string }

export type ComposerRemoteChatState = {
  /**
   * Whether the two lists below could be READ at all — and it is REQUIRED, so that a second
   * builder of this state cannot omit it and land back on the empty-means-none reading.
   *
   * 🔴 `accounts: []` and `binding: undefined` are the values a healthy, unconfigured instance
   * produces AND the values an unreachable one produces, and this section renders the first as
   * *"No messenger accounts yet — add one in Settings"* and the second as *"this chat drives
   * nothing"*. Both are false sentences over a request that never landed, which is ruling 2's
   * second half exactly. The controller has carried this reading since it was built; it is read
   * here — a state nothing renders is a state that does not exist.
   *
   * Precedence is the helpers' own: **failed > loading > ready**. `ready` is a settled answer and
   * says nothing about whether it was empty.
   */
  availability: "ready" | "loading" | "failed"
  /** false for a draft — there is no sessionID to bind yet (edge #15). */
  bindable: boolean
  accounts: readonly ComposerRemoteAccount[]
  binding: ComposerRemoteBinding | undefined
  loadChats: (
    accountID: string,
  ) => Promise<{ ok: boolean; chats: readonly ComposerRemoteChatChoice[]; reason?: string }>
  /** "bound" = the chat already drives another session — offer an explicit steal (edge #3). */
  connect: (input: {
    accountID: string
    chatID: string
    trust: ComposerRemoteTrust
    steal?: boolean
  }) => Promise<"ok" | "bound" | "failed">
  disconnect: () => Promise<void>
  openSettings: () => void
}

/** What actually happened when the user pressed "Make Default for this Folder". */
export type ComposerFeaturesControlState = {
  current: Record<ComposerFeature, boolean>
  override: Partial<Record<ComposerFeature, boolean>>
  /** Per switch, where the value came from when this chat did not set it. Absent = not yet known. */
  origin: Partial<Record<ComposerFeature, ComposerFeatureOrigin>>
  mode: ComposerMode
  /** The colleague this chat is talking to. Tune opens ITS config, so a chat whose agent has not
   *  resolved yet opens the dialog on the chat section alone rather than on the wrong profile. */
  agent: string | undefined
  remote: ComposerRemoteChatState
  style: JSX.CSSProperties | undefined
  set: (feature: ComposerFeature, enabled: boolean) => void
  inherit: (feature: ComposerFeature) => void
  setMode: (value: ComposerMode) => void
  onClose: () => void
}

// `thinkingBudget` is deliberately ABSENT (owner 2026-07-26): a reasoning budget belongs to the MODEL, not
// to one chat, and it now lives in Settings → Models → configure, where "Disabled" is simply one of the
// budget values. The per-session plumbing (event, column, config walk) is left in place and inert — it costs
// nothing, and ripping a column out of shipped sessions buys nothing at this point.
// `safeMode` sits FIRST and next to the other two restrictions (anti-obscurantist UI: a per-session
// toggle is a visible composer control, never a hidden menu). It is the control `agent-jail.ts`'s
// deny message points at by name — "Turn Safe mode off in this chat's Tuning controls" — so it
// being on this list is what makes that sentence true rather than a ruling-2 false description.
const COMPOSER_FEATURES: readonly ComposerFeature[] = [
  "safeMode",
  "askBeforeChanges",
  "surgicalEdits",
  "contextBudget",
  // `memory` is RETIRED from this list, not from the schema: the per-chat switch duplicated the
  // agent's own "Persistent Agent Memory (RAG)" toggle one level down, and the two could disagree —
  // an agent with memory on, tuned chat-by-chat off, read as "broken memory". The stance lives on
  // the colleague (officer-settings-screen); a session that stored this feature BEFORE retirement keeps
  // its stored value silently (same rule as `safeMode` above: no column is ripped out of shipped
  // sessions), and every other chat inherits the agent's stance.
  "introspection",
  "quality",
  "affective",
]
const COMPOSER_MODES: readonly ComposerMode[] = ["interactive", "auto-prompting", "goal-oriented"]

const REMOTE_TRUSTS: readonly ComposerRemoteTrust[] = ["operator", "client", "audience"]

const REMOTE_DOT: Record<string, string> = {
  connected: "bg-v2-state-fg-success",
  connecting: "bg-v2-state-fg-warning",
  backoff: "bg-v2-state-fg-warning",
  challenge: "bg-v2-state-fg-danger",
  error: "bg-v2-state-fg-danger",
  disabled: "bg-v2-icon-icon-muted",
  airgapped: "bg-v2-icon-icon-muted",
}

/**
 * The Remote-chat picker: messaging app → chat → the required access-level step (§0.1).
 *
 * Exported so a render test can mount THIS, rather than the 400-line panel and the eight contexts
 * it needs, to assert which of its four states it prints. The panel below is its only caller.
 */
export function RemoteChatSection(props: { remote: ComposerRemoteChatState }) {
  const language = useLanguage()
  const [stage, setStage] = createSignal<"idle" | "account" | "chat" | "trust">("idle")
  const [account, setAccount] = createSignal<ComposerRemoteAccount | undefined>(undefined)
  const [chats, setChats] = createSignal<
    { loading: boolean; ok: boolean; list: readonly ComposerRemoteChatChoice[]; reason?: string } | undefined
  >(undefined)
  const [chat, setChat] = createSignal<ComposerRemoteChatChoice | undefined>(undefined)
  const [manual, setManual] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [conflict, setConflict] = createSignal(false)

  const reset = () => {
    setStage("idle")
    setAccount(undefined)
    setChats(undefined)
    setChat(undefined)
    setManual("")
    setConflict(false)
  }

  const pickAccount = (entry: ComposerRemoteAccount) => {
    setAccount(entry)
    setStage("chat")
    setChats({ loading: true, ok: true, list: [] })
    void props.remote.loadChats(entry.id).then((result) =>
      setChats({
        loading: false,
        ok: result.ok,
        list: result.chats,
        ...(result.reason ? { reason: result.reason } : {}),
      }),
    )
  }

  const finish = (trust: ComposerRemoteTrust, steal?: boolean) => {
    const chosenAccount = account()
    const chosenChat = chat()
    if (!chosenAccount || !chosenChat || busy()) return
    setBusy(true)
    void props.remote
      .connect({ accountID: chosenAccount.id, chatID: chosenChat.chatID, trust, ...(steal ? { steal: true } : {}) })
      .then((outcome) => {
        setBusy(false)
        if (outcome === "ok") reset()
        else if (outcome === "bound") setConflict(true)
      })
  }
  // Remember the picked trust so the steal retry reuses it.
  const [pickedTrust, setPickedTrust] = createSignal<ComposerRemoteTrust>("operator")

  const row =
    "flex items-start justify-between gap-3 rounded-md border border-transparent px-2.5 py-1.5 text-left hover:bg-v2-background-bg-layer-02"

  /**
   * 🔴 **What to say when there is no account list to show — and it is THREE answers, not one.**
   *
   * An empty `accounts` is what a healthy instance with no messengers returns; it is ALSO what the
   * state holds when the request never landed, and *"No messenger accounts yet — add one in
   * Settings"* then sends a user who has three configured accounts to a Settings screen to hunt
   * for a fault that is not there. `availability` is the controller's own reading of whether the
   * lists could be read at all — it has been computed since the messenger reads were converted,
   * and nothing rendered it, which is the same as not having it.
   *
   * ⚠️ `loading` is consulted only once the list is EMPTY, deliberately: the section refetches on
   * every `messenger.*` event, and a re-read in flight over accounts we already hold must not
   * blank a picker the user is standing in.
   */
  const noAccountList = () => (
    <Switch
      fallback={
        <button
          type="button"
          data-action="remote-open-settings"
          class="self-start text-[13px] text-v2-text-text-base underline decoration-dotted hover:text-v2-text-text-base"
          onClick={() => props.remote.openSettings()}
        >
          {language.t("prompt.remote.none")}
        </button>
      }
    >
      <Match when={props.remote.availability === "failed"}>
        <span data-slot="remote-unavailable" role="status" class="text-[12px] leading-4 text-v2-text-text-faint">
          {language.t("prompt.remote.unavailable")}
        </span>
      </Match>
      <Match when={props.remote.availability === "loading"}>
        <span data-slot="remote-checking" role="status" class="text-[12px] leading-4 text-v2-text-text-faint">
          {language.t("prompt.remote.checking")}
        </span>
      </Match>
    </Switch>
  )

  return (
    <div class="flex flex-col gap-1.5" data-section="remote-chat">
      <span class="text-[13px] font-[560] text-v2-text-text-base">{language.t("prompt.remote.title")}</span>
      <ControlScope kind="chat" />
      <Show
        when={props.remote.binding}
        fallback={
          <Show
            when={props.remote.bindable}
            fallback={
              <span class="text-[12px] leading-4 text-v2-text-text-faint">{language.t("prompt.remote.draft")}</span>
            }
          >
            <Show
              when={props.remote.availability !== "failed" && props.remote.accounts.length > 0}
              fallback={noAccountList()}
            >
              <Show
                when={stage() !== "idle"}
                fallback={
                  <button type="button" data-action="remote-link" class={row} onClick={() => setStage("account")}>
                    <span class="text-[13px] text-v2-text-text-base">{language.t("prompt.remote.link")}</span>
                    <Icon name="chevron-right" size="normal" class="mt-0.5 shrink-0 text-v2-icon-icon-muted" />
                  </button>
                }
              >
                <Show when={stage() === "account"}>
                  <span class="text-[12px] text-v2-text-text-faint">{language.t("prompt.remote.pickAccount")}</span>
                  <For each={props.remote.accounts}>
                    {(entry) => (
                      <button
                        type="button"
                        data-remote-account={entry.id}
                        class={row}
                        onClick={() => pickAccount(entry)}
                      >
                        <span class="flex items-center gap-2">
                          <span
                            class={`size-2 shrink-0 rounded-full ${REMOTE_DOT[entry.state] ?? "bg-v2-icon-icon-muted"}`}
                          />
                          <span class="text-[13px] text-v2-text-text-base">{entry.label}</span>
                          <span class="text-[12px] text-v2-text-text-faint">{entry.driverName}</span>
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
                <Show when={stage() === "chat"}>
                  <span class="text-[12px] text-v2-text-text-faint">{language.t("prompt.remote.pickChat")}</span>
                  <Show
                    when={!chats()?.loading}
                    fallback={
                      <span class="text-[12px] text-v2-text-text-faint">{language.t("prompt.remote.loading")}</span>
                    }
                  >
                    <Show when={chats()?.ok === false}>
                      <span class="text-[12px] leading-4 text-v2-text-text-faint">{chats()?.reason}</span>
                    </Show>
                    <Show when={chats()?.ok !== false && (chats()?.list.length ?? 0) === 0}>
                      <span class="text-[12px] leading-4 text-v2-text-text-faint">
                        {language.t("prompt.remote.chatsEmpty")}
                      </span>
                    </Show>
                    <div class="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                      <For each={chats()?.list ?? []}>
                        {(entry) => (
                          <button
                            type="button"
                            data-remote-chat={entry.chatID}
                            class={row}
                            onClick={() => {
                              setChat(entry)
                              setStage("trust")
                            }}
                          >
                            <span class="text-[13px] text-v2-text-text-base">{entry.title || entry.chatID}</span>
                          </button>
                        )}
                      </For>
                    </div>
                    {/* Manual handle entry — IRC/email style drivers can't enumerate (§6.2). */}
                    <div class="flex items-center gap-1.5">
                      <input
                        type="text"
                        data-action="remote-manual"
                        class="h-7 min-w-0 flex-1 rounded-md border border-border-base bg-transparent px-2 text-[13px] text-v2-text-text-base placeholder:text-v2-text-text-faint outline-none"
                        placeholder={language.t("prompt.remote.manual")}
                        value={manual()}
                        onInput={(event) => setManual(event.currentTarget.value)}
                      />
                      <button
                        type="button"
                        data-action="remote-manual-use"
                        class="h-7 rounded-md px-2 text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02 disabled:opacity-50"
                        disabled={manual().trim().length === 0}
                        onClick={() => {
                          const value = manual().trim()
                          if (!value) return
                          setChat({ chatID: value, title: value })
                          setStage("trust")
                        }}
                      >
                        {language.t("prompt.remote.manualUse")}
                      </button>
                    </div>
                  </Show>
                </Show>
                <Show when={stage() === "trust"}>
                  <span class="text-[12px] font-[560] text-v2-text-text-base">
                    {language.t("prompt.remote.trust.title")}
                  </span>
                  <Show when={conflict()}>
                    <div class="flex flex-col gap-1 rounded-md border border-border-base px-2.5 py-1.5">
                      <span class="text-[12px] leading-4 text-v2-text-text-faint">
                        {language.t("prompt.remote.conflict")}
                      </span>
                      <button
                        type="button"
                        data-action="remote-steal"
                        class="self-start text-[13px] text-v2-text-text-base underline decoration-dotted"
                        disabled={busy()}
                        onClick={() => finish(pickedTrust(), true)}
                      >
                        {language.t("prompt.remote.conflict.steal")}
                      </button>
                    </div>
                  </Show>
                  <For each={REMOTE_TRUSTS}>
                    {(trust) => (
                      <button
                        type="button"
                        data-remote-trust={trust}
                        class={row}
                        disabled={busy()}
                        onClick={() => {
                          setPickedTrust(trust)
                          finish(trust)
                        }}
                      >
                        <span class="flex flex-col gap-0.5">
                          <span class="text-[13px] text-v2-text-text-base">
                            {language.t(`prompt.remote.trust.${trust}.title`)}
                          </span>
                          <span class="text-[12px] leading-4 text-v2-text-text-faint">
                            {language.t(`prompt.remote.trust.${trust}.description`)}
                          </span>
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
                <button
                  type="button"
                  data-action="remote-back"
                  class="self-start text-[12px] text-v2-text-text-faint hover:text-v2-text-text-base"
                  onClick={() => {
                    if (stage() === "trust") {
                      setConflict(false)
                      setChat(undefined)
                      setStage("chat")
                    } else if (stage() === "chat") {
                      setChats(undefined)
                      setAccount(undefined)
                      setStage("account")
                    } else reset()
                  }}
                >
                  {language.t("prompt.remote.back")}
                </button>
              </Show>
            </Show>
          </Show>
        }
      >
        {(binding) => (
          <div
            class="flex items-center justify-between gap-2 rounded-md border border-border-base px-2.5 py-1.5"
            data-remote-bound
          >
            <span class="flex min-w-0 items-center gap-2">
              <span
                class={`size-2 shrink-0 rounded-full ${REMOTE_DOT[binding().accountState] ?? "bg-v2-icon-icon-muted"}`}
              />
              <span class="truncate text-[13px] text-v2-text-text-base">
                {language.t("prompt.remote.connected", { driver: binding().driverName, chat: binding().chatTitle })}
              </span>
              <span class="shrink-0 rounded-sm bg-v2-background-bg-layer-02 px-1.5 text-[11px] text-v2-text-text-faint">
                {language.t(`prompt.remote.trust.${binding().trust}.title`)}
              </span>
            </span>
            <button
              type="button"
              data-action="remote-disconnect"
              class="shrink-0 text-[12px] text-v2-text-text-faint hover:text-v2-text-text-base"
              onClick={() => void props.remote.disconnect()}
            >
              {language.t("prompt.remote.disconnect")}
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}

export function useTunePanelOpener(state: () => ComposerFeaturesControlState) {
  const props = {
    get state() {
      return state()
    },
  }
  return composerTunePanel(props)
}

function composerTunePanel(props: { state: ComposerFeaturesControlState }) {
  // The ONE shared roster, refreshed after a Tune save. Resolved
  // here rather than threaded in as a prop: it is a singleton per connection, so every surface that
  // needs it reaches for the same one, and a prop would make each caller responsible for remembering.
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const location = useLocation()
  const enabledCount = () => COMPOSER_FEATURES.filter((feature) => props.state.current[feature]).length

  const unattended = () => props.state.mode !== "interactive"
  // The enabled-COUNT is deliberately not shown (owner 2026-07-26): "Tune · 2" spends width on a number
  // that tells you nothing actionable — you still have to open it to see WHICH two. The unattended-mode
  // marker stays, because that one changes what the agent may do without you.
  const triggerSuffix = () => {
    // Narrowed, not cast: the guard already excludes "interactive" (which has no `.short` key by
    // design), but a `() => boolean` helper cannot narrow `props.state.mode` for the compiler.
    const mode = props.state.mode
    if (mode === "interactive") return ""
    return ` · ${language.t(`prompt.mode.short.${mode}`)}`
  }
  // `onClose` is the composer's "the user finished tuning" hook (it re-reads the session record), so it
  // fires when the dialog goes away by ANY route — button, overlay click or Escape — via dialog.show's
  // own onClose callback rather than a hand-rolled handler per dismissal path.
  //
  // 🔴 **`showScoped`, not `show`, and the difference is a mis-targeted WRITE.** `dialog.show` mounts
  // under `createRoot`, which is DETACHED — the panel's root is never linked to this component's
  // lifetime — while everything the panel renders and acts on lives in `props.state`, a memo the
  // composer owns. Measured in dev Electron: open Tune on a draft in one folder, deep-link the draft
  // to another, and the still-open panel keeps the FROZEN state of the folder you left. It says
  // "This folder has no project file yet. Saving creates one here.", and pressing Save as folder
  // default creates `novaclaw.json` in the OLD folder while the new one stays empty. `showScoped`
  // binds the panel's life to this composer, so a route change takes it with it.
  // 🔴 Tune now opens the COLLEAGUE'S SETTINGS SCREEN, with this chat's controls as a section inside it
  // (AGENTS.md — the structural metaphor). The old panel said settings belong to a conversation;
  // under the roster they belong to whoever you are talking to, and only "how this chat runs" is
  // the conversation's own. The Contacts app opens the same route, so there is one place to learn.
  //
  // ⚠️ `onDismiss` CLOSES THE DIALOG, it does not merely fire the composer's hook. It used to call
  // only `props.state.onClose()`, which re-reads the session record and leaves the panel standing —
  // so Close and Cancel did nothing visible. That went unnoticed because the panel was closing by
  // accident on every click (it rendered a bare `<div>` under the stack's `pointer-events: none`
  // layer, so clicks fell through to the overlay). Fixing the modal made the dead button visible.
  // `stack.close` runs the `onClose` passed below, so the composer's hook still fires exactly once.
  const openPanel = () => {
    const agentID = props.state.agent
    if (!agentID) {
      void dialog.showScoped(
        () => <TuningPanel state={props.state} onDismiss={() => dialog.close()} />,
        () => props.state.onClose(),
      )
      return
    }
    const returnTo = `${location.pathname}${location.search}`
    navigate(`/officers/${encodeURIComponent(agentID)}/settings?returnTo=${encodeURIComponent(returnTo)}`)
  }
  /**
   * ⚠️ **The unattended-mode marker travels WITH the trigger.** It rode the old button's label and
   * would have died with it, and the note that put it there is explicit about why it earns its width
   * while the enabled-count does not: this one *"changes what the agent may do without you"*. It is a
   * safety signal, so it moves to whatever the user now presses rather than being quietly dropped
   * with the control that used to carry it.
   */
  return { open: openPanel, modeSuffix: triggerSuffix, unattended, enabledCount }
}

/**
 * The Tuning panel itself, as a MODAL rather than a popover. It outgrew a dropdown — a mode radio group,
 * the remote-chat section and six switches do not fit in an anchored panel, and on a phone a popover that
 * tall is unusable. A centered dialog scrolls and can be dismissed the ordinary way.
 */
export function TuningPanel(props: { state: ComposerFeaturesControlState; onDismiss: () => void; embedded?: boolean }) {
  const featureSource = (feature: ComposerFeature) => {
    const state = language.t(`prompt.features.state.${props.state.current[feature] ? "on" : "off"}`)
    if (props.state.override[feature] !== undefined) return language.t("prompt.features.source.override")
    const origin = props.state.origin[feature]
    if (origin?.kind === "session") return language.t("prompt.features.source.parent", { state })
    if (origin?.kind === "officer") return language.t("prompt.features.source.officer", { state })
    return undefined
  }

  /** A switch's title, for the project section's lists. Unknown names render as themselves. */
  const featureTitle = (name: string) =>
    (COMPOSER_FEATURES as readonly string[]).includes(name)
      ? language.t(`prompt.features.${name as ComposerFeature}.title`)
      : name
  const language = useLanguage()
  // EMBEDDED = this panel is a section inside the colleague's config dialog, so it renders neither
  // its own modal shell (a dialog inside a dialog) nor its own title (the section already carries
  // one). Standalone is kept for any caller that still wants the panel on its own.
  const body = (
    <div
      data-component="prompt-features-panel"
      classList={{
        "flex flex-col gap-3": true,
        "max-h-[80vh] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto p-5": !props.embedded,
      }}
    >
      <ControlScope kind="chat" />
      <Show when={!props.embedded}>
        <div class="flex flex-col gap-1">
          <span class="text-[13px] font-[560] text-v2-text-text-base">
            {language.t("prompt.features.popover.title")}
          </span>
          <span class="text-[12px] leading-4 text-v2-text-text-faint">
            {language.t("prompt.features.popover.description")}
          </span>
        </div>
      </Show>
      <div class="flex flex-col gap-1.5" data-section="posture">
        <span class="text-[13px] font-[560] text-v2-text-text-base">{language.t("prompt.posture.section.title")}</span>
        <div role="radiogroup" aria-label={language.t("prompt.posture.section.title")} class="flex flex-col gap-1">
          {(["chat", "agent"] as const).map((posture) => {
            const selected = () => props.state.current.shortChat === (posture === "chat")
            return (
              <button
                type="button"
                role="radio"
                data-posture-option={posture}
                aria-checked={selected()}
                onClick={() => props.state.set("shortChat", posture === "chat")}
                class="flex items-start justify-between gap-3 rounded-md border px-2.5 py-1.5 text-left hover:bg-v2-background-bg-layer-02"
                classList={{
                  "border-v2-border-border-focus bg-v2-background-bg-layer-01": selected(),
                  "border-transparent": !selected(),
                }}
              >
                <span class="flex flex-col gap-0.5">
                  <span class="text-[13px] text-v2-text-text-base">
                    {language.t(`prompt.posture.${posture}.title`)}
                  </span>
                  <span class="text-[12px] leading-4 text-v2-text-text-faint">
                    {language.t(`prompt.posture.${posture}.description`)}
                  </span>
                </span>
                <Show when={selected()}>
                  <Icon name="check" size="normal" class="mt-0.5 shrink-0 text-v2-icon-icon-accent" />
                </Show>
              </button>
            )
          })}
        </div>
        <span class="text-[11px] leading-4 text-v2-text-text-faint" data-posture-source>
          {props.state.override.shortChat === undefined
            ? language.t("prompt.features.source.inherit", {
                state: language.t(`prompt.posture.${props.state.current.shortChat ? "chat" : "agent"}.title`),
              })
            : language.t("prompt.features.source.override")}
        </span>
        <Show when={props.state.override.shortChat !== undefined}>
          <button
            type="button"
            data-action="prompt-posture-inherit"
            class="self-start text-[11px] text-v2-text-text-faint underline decoration-dotted hover:text-v2-text-text-base"
            onClick={() => props.state.inherit("shortChat")}
          >
            {language.t("prompt.features.useDefault")}
          </button>
        </Show>
      </div>
      {/* The chat's Mode — plain radio rows (a Kobalte Select re-emits onChange; see the
              per-session-toggle template notes), and the unattended options explain their
              guardrails inline so the switch teaches what it does. */}
      <div class="flex flex-col gap-1.5" data-section="mode">
        <span class="text-[13px] font-[560] text-v2-text-text-base">{language.t("prompt.mode.title")}</span>
        <div role="radiogroup" aria-label={language.t("prompt.mode.title")} class="flex flex-col gap-1">
          {COMPOSER_MODES.map((mode) => (
            <button
              type="button"
              role="radio"
              data-mode-option={mode}
              aria-checked={props.state.mode === mode}
              onClick={() => props.state.setMode(mode)}
              class="flex items-start justify-between gap-3 rounded-md border px-2.5 py-1.5 text-left hover:bg-v2-background-bg-layer-02"
              classList={{
                "border-v2-border-border-focus bg-v2-background-bg-layer-01": props.state.mode === mode,
                "border-transparent": props.state.mode !== mode,
              }}
            >
              <span class="flex flex-col gap-0.5">
                <span class="text-[13px] text-v2-text-text-base">{language.t(`prompt.mode.${mode}.title`)}</span>
                <span class="text-[12px] leading-4 text-v2-text-text-faint">
                  {language.t(`prompt.mode.${mode}.description`)}
                </span>
              </span>
              {props.state.mode === mode && (
                <Icon name="check" size="normal" class="mt-0.5 shrink-0 text-v2-icon-icon-accent" />
              )}
            </button>
          ))}
        </div>
      </div>
      <RemoteChatSection remote={props.state.remote} />
      {COMPOSER_FEATURES.map((feature) => (
        <div class="flex items-start justify-between gap-3" data-feature={feature}>
          <div class="flex flex-col gap-0.5">
            <span class="text-[13px] text-v2-text-text-base">{language.t(`prompt.features.${feature}.title`)}</span>
            <span class="text-[12px] leading-4 text-v2-text-text-faint">
              {language.t(`prompt.features.${feature}.description`)}
              {/* uix.md §1.4 — the line states what the switch does; the trade and the cases it
                    does not affect are one gesture away. Conditional because only some features have
                    a second half, and a `?` with nothing behind it is a dead control. */}
              <Show when={feature === "safeMode"}>
                <SettingsExplainV2 label={language.t(`prompt.features.${feature}.title`)}>
                  {language.t("prompt.features.safeMode.description.more")}
                </SettingsExplainV2>
              </Show>
            </span>
            <Show when={featureSource(feature)}>
              {(source) => (
                <span class="text-[11px] leading-4 text-v2-text-text-faint" data-feature-source>
                  {source()}
                </span>
              )}
            </Show>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <SwitchToggle
              checked={props.state.current[feature]}
              onChange={(checked) => props.state.set(feature, checked)}
              hideLabel
            >
              {language.t(`prompt.features.${feature}.title`)}
            </SwitchToggle>
            <Show when={props.state.override[feature] !== undefined}>
              <button
                type="button"
                data-action="prompt-feature-inherit"
                class="text-[11px] text-v2-text-text-faint underline decoration-dotted hover:text-v2-text-text-base"
                onClick={() => props.state.inherit(feature)}
              >
                {language.t("prompt.features.useDefault")}
              </button>
            </Show>
          </div>
        </div>
      ))}
    </div>
  )
  return props.embedded ? body : <Dialog size="content">{body}</Dialog>
}
