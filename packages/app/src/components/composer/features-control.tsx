import { createSignal, For, Show, type JSX } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { Icon } from "@novaclaw/ui/icon"
import { Switch as SwitchToggle } from "@novaclaw/ui/v2/switch-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"

export type ComposerFeature = "introspection" | "quality" | "affective" | "thinkingBudget" | "surgicalEdits" | "askBeforeChanges"
export type ComposerMode = "interactive" | "auto-prompting" | "goal-oriented"

// The Remote-chat section (messenger-plan §6.2): where does THIS chat live remotely? The trust
// tier is a REQUIRED, user-chosen step of every connect (§0.1) — three plain-language cards, never
// inferred, never skippable.
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
  /** false for a draft — there is no sessionID to bind yet (edge #15). */
  bindable: boolean
  accounts: readonly ComposerRemoteAccount[]
  binding: ComposerRemoteBinding | undefined
  loadChats: (accountID: string) => Promise<{ ok: boolean; chats: readonly ComposerRemoteChatChoice[]; reason?: string }>
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

export type ComposerFeaturesControlState = {
  current: Record<ComposerFeature, boolean>
  mode: ComposerMode
  remote: ComposerRemoteChatState
  style: JSX.CSSProperties | undefined
  set: (feature: ComposerFeature, enabled: boolean) => void
  setMode: (value: ComposerMode) => void
  onClose: () => void
}

// `thinkingBudget` is deliberately ABSENT (owner 2026-07-26): a reasoning budget belongs to the MODEL, not
// to one chat, and it now lives in Settings → Models → configure, where "Disabled" is simply one of the
// budget values. The per-session plumbing (event, column, config walk) is left in place and inert — it costs
// nothing, and ripping a column out of shipped sessions buys nothing at this point.
const COMPOSER_FEATURES: readonly ComposerFeature[] = [
  "askBeforeChanges",
  "surgicalEdits",
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

/** The Remote-chat picker: messaging app → chat → the required access-level step (§0.1). */
function RemoteChatSection(props: { remote: ComposerRemoteChatState }) {
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
      setChats({ loading: false, ok: result.ok, list: result.chats, ...(result.reason ? { reason: result.reason } : {}) }),
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
    "flex items-start justify-between gap-3 rounded-md border border-transparent px-2.5 py-1.5 text-left hover:bg-v2-background-bg-subtle"

  return (
    <div class="flex flex-col gap-1.5" data-section="remote-chat">
      <span class="text-[13px] font-[560] text-v2-text-text-base">{language.t("prompt.remote.title")}</span>
      <Show
        when={props.remote.binding}
        fallback={
          <Show
            when={props.remote.bindable}
            fallback={<span class="text-[12px] leading-4 text-v2-text-text-faint">{language.t("prompt.remote.draft")}</span>}
          >
            <Show
              when={props.remote.accounts.length > 0}
              fallback={
                <button
                  type="button"
                  data-action="remote-open-settings"
                  class="self-start text-[13px] text-v2-text-text-base underline decoration-dotted hover:text-v2-text-text-strong"
                  onClick={() => props.remote.openSettings()}
                >
                  {language.t("prompt.remote.none")}
                </button>
              }
            >
              <Show
                when={stage() !== "idle"}
                fallback={
                  <button
                    type="button"
                    data-action="remote-link"
                    class={row}
                    onClick={() => setStage("account")}
                  >
                    <span class="text-[13px] text-v2-text-text-base">{language.t("prompt.remote.link")}</span>
                    <Icon name="chevron-right" size="small" class="mt-0.5 shrink-0 text-v2-icon-icon-muted" />
                  </button>
                }
              >
                <Show when={stage() === "account"}>
                  <span class="text-[12px] text-v2-text-text-faint">{language.t("prompt.remote.pickAccount")}</span>
                  <For each={props.remote.accounts}>
                    {(entry) => (
                      <button type="button" data-remote-account={entry.id} class={row} onClick={() => pickAccount(entry)}>
                        <span class="flex items-center gap-2">
                          <span class={`size-2 shrink-0 rounded-full ${REMOTE_DOT[entry.state] ?? "bg-v2-icon-icon-muted"}`} />
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
                    fallback={<span class="text-[12px] text-v2-text-text-faint">{language.t("prompt.remote.loading")}</span>}
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
                        class="h-7 rounded-md px-2 text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-subtle disabled:opacity-50"
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
                  <span class="text-[12px] font-[560] text-v2-text-text-base">{language.t("prompt.remote.trust.title")}</span>
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
                            {language.t(`prompt.remote.trust.${trust}.title` as Parameters<typeof language.t>[0])}
                          </span>
                          <span class="text-[12px] leading-4 text-v2-text-text-faint">
                            {language.t(`prompt.remote.trust.${trust}.description` as Parameters<typeof language.t>[0])}
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
          <div class="flex items-center justify-between gap-2 rounded-md border border-border-base px-2.5 py-1.5" data-remote-bound>
            <span class="flex min-w-0 items-center gap-2">
              <span class={`size-2 shrink-0 rounded-full ${REMOTE_DOT[binding().accountState] ?? "bg-v2-icon-icon-muted"}`} />
              <span class="truncate text-[13px] text-v2-text-text-base">
                {language.t("prompt.remote.connected", { driver: binding().driverName, chat: binding().chatTitle })}
              </span>
              <span class="shrink-0 rounded-sm bg-v2-background-bg-subtle px-1.5 text-[11px] text-v2-text-text-faint">
                {language.t(`prompt.remote.trust.${binding().trust}.title` as Parameters<typeof language.t>[0])}
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

/**
 * The per-chat Tuning control (T1, Advanced+): the chat's Mode (kernel thread type — interactive
 * vs the unattended pair, architecture.md typed threads) plus one switch per harness helper —
 * the stuck detector (introspection), quality gates, and mood sampling (affective). Each control
 * shows the EFFECTIVE stance (this chat's override, else the global Settings default) and a flip
 * writes the per-chat override; the helpers' internals stay in Settings.
 */
export function ComposerFeaturesControl(props: { state: ComposerFeaturesControlState }) {
  const language = useLanguage()
  const dialog = useDialog()
  const enabledCount = () => COMPOSER_FEATURES.filter((feature) => props.state.current[feature]).length
  const unattended = () => props.state.mode !== "interactive"
  // The enabled-COUNT is deliberately not shown (owner 2026-07-26): "Tune · 2" spends width on a number
  // that tells you nothing actionable — you still have to open it to see WHICH two. The unattended-mode
  // marker stays, because that one changes what the agent may do without you.
  const triggerSuffix = () => {
    if (!unattended()) return ""
    return ` · ${language.t(`prompt.mode.short.${props.state.mode}` as Parameters<typeof language.t>[0])}`
  }
  // `onClose` is the composer's "the user finished tuning" hook (it re-reads the session record), so it
  // fires when the dialog goes away by ANY route — button, overlay click or Escape — via dialog.show's
  // own onClose callback rather than a hand-rolled handler per dismissal path.
  const openPanel = () =>
    void dialog.show(
      () => <TuningPanel state={props.state} onDismiss={() => props.state.onClose()} />,
      () => props.state.onClose(),
    )
  return (
    <>
      <TooltipV2 placement="top" gutter={4} value={language.t("prompt.features.tooltip")}>
        <button
          type="button"
          onClick={openPanel}
          data-action="prompt-features"
          data-enabled-count={enabledCount() || undefined}
          data-mode={unattended() ? props.state.mode : undefined}
          class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-5 hover:bg-v2-background-bg-subtle"
          classList={{
            "text-v2-text-text-faint": enabledCount() === 0 && !unattended(),
            "text-v2-text-text-base": enabledCount() > 0 || unattended(),
          }}
          style={props.state.style}
        >
          <span>
            {language.t("prompt.features.label")}
            {triggerSuffix()}
          </span>
        </button>
      </TooltipV2>
    </>
  )
}

/**
 * The Tuning panel itself, as a MODAL rather than a popover. It outgrew a dropdown — a mode radio group,
 * the remote-chat section and six switches do not fit in an anchored panel, and on a phone a popover that
 * tall is unusable. A centered dialog scrolls and can be dismissed the ordinary way.
 */
function TuningPanel(props: { state: ComposerFeaturesControlState; onDismiss: () => void }) {
  const language = useLanguage()
  return (
    <Dialog size="content">
      <div
        data-component="prompt-features-panel"
        class="flex max-h-[80vh] w-[min(30rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto p-5"
      >
          <div class="flex flex-col gap-1">
            <span class="text-[13px] font-[560] text-v2-text-text-base">
              {language.t("prompt.features.popover.title")}
            </span>
            <span class="text-[12px] leading-4 text-v2-text-text-faint">
              {language.t("prompt.features.popover.description")}
            </span>
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
                  class="flex items-start justify-between gap-3 rounded-md border px-2.5 py-1.5 text-left hover:bg-v2-background-bg-subtle"
                  classList={{
                    "border-v2-border-border-focus bg-v2-background-bg-layer-01": props.state.mode === mode,
                    "border-transparent": props.state.mode !== mode,
                  }}
                >
                  <span class="flex flex-col gap-0.5">
                    <span class="text-[13px] text-v2-text-text-base">
                      {language.t(`prompt.mode.${mode}.title` as Parameters<typeof language.t>[0])}
                    </span>
                    <span class="text-[12px] leading-4 text-v2-text-text-faint">
                      {language.t(`prompt.mode.${mode}.description` as Parameters<typeof language.t>[0])}
                    </span>
                  </span>
                  {props.state.mode === mode && (
                    <Icon name="check" size="small" class="mt-0.5 shrink-0 text-v2-icon-icon-accent" />
                  )}
                </button>
              ))}
            </div>
          </div>
          <RemoteChatSection remote={props.state.remote} />
          {COMPOSER_FEATURES.map((feature) => (
            <div class="flex items-start justify-between gap-3" data-feature={feature}>
              <div class="flex flex-col gap-0.5">
                <span class="text-[13px] text-v2-text-text-base">
                  {language.t(`prompt.features.${feature}.title` as Parameters<typeof language.t>[0])}
                </span>
                <span class="text-[12px] leading-4 text-v2-text-text-faint">
                  {language.t(`prompt.features.${feature}.description` as Parameters<typeof language.t>[0])}
                </span>
              </div>
              <SwitchToggle
                checked={props.state.current[feature]}
                onChange={(checked) => props.state.set(feature, checked)}
                hideLabel
              >
                {language.t(`prompt.features.${feature}.title` as Parameters<typeof language.t>[0])}
              </SwitchToggle>
            </div>
          ))}
      </div>
    </Dialog>
  )
}
