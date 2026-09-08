import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { Icon } from "@novaclaw/ui/v2/icon"
import { Switch as SwitchToggle } from "@novaclaw/ui/v2/switch-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { AgentConfigDialog } from "@/components/agent-config-dialog"
import { ControlScope } from "@/components/control-scope"
import { SettingsExplainV2 } from "@/components/settings-v2/explain"
import { useLanguage } from "@/context/language"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { pathKey } from "@/utils/path-key"
import { inForceState, makeDefaultPayload, planMakeDefault } from "./make-default"

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

/**
 * Where a switch's value came from when THIS chat did not set it.
 *
 * The panel used to say only "Using Settings default" for every such switch, which is the honest
 * answer for exactly one of the three cases below. A user whose repository ships a `novaclaw.json`
 * saw "Settings default" for a value Settings never chose, and had nothing to read that would tell
 * them otherwise — the shape of question this whole surface exists to answer.
 */
export type ComposerFeatureOrigin =
  /**
   * An ancestor chat declared it, and this chat inherits down the spawn chain.
   *
   * ⚠️ Measured 2026-08-13: this arm is CORRECT and currently unreachable from this panel. A session
   * with a parent renders as a helper ("you can't message it directly") and has no composer, so the
   * only chats that open this dialog are roots. It is kept rather than dropped because the
   * distinction is real on the wire — `config-provenance.ts` pins that a chain layer outranks the
   * default source — and the day a parented chat gets a composer, the wrong answer would be the
   * silent one.
   */
  | { kind: "session" }
  /** The folder's `novaclaw.json` supplied it. `file` is the path, because opening it is the next move. */
  | { kind: "project"; file: string }
  /** Nothing above the instance chose it — the app's own default. */
  | { kind: "instance" }

/** The project governing this chat's folder, and what its file actually did. */
export type ComposerProjectLayer = {
  root: string
  file: string
  /** Switches the file supplied. */
  applied: readonly string[]
  /**
   * Switches it asked for and did not get. A folder may RAISE a supervision switch, never lower
   * one, so a cloned repository cannot disarm the user's own rails — and saying so is better than
   * a file that silently half-applies.
   */
  refused: readonly string[]
}

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
export type ComposerMakeDefaultReceipt =
  | {
      kind: "written"
      file: string
      /** `true` when there was no file before, so the receipt says "Created" rather than "Updated". */
      created: boolean
      /** The sections replaced. Everything else in the file — permissions included — is unchanged. */
      sections: readonly string[]
      /** Supervision switches left out, because a folder's file may raise a rail and never lower one. */
      refused: readonly string[]
    }
  /** The folder has a `novaclaw.json` that does not parse. Nothing was written; their file is intact. */
  | { kind: "refused"; file: string; reason: string; detail: string }
  /** The request itself did not land. Distinct from a refusal: nothing is wrong with their file. */
  | { kind: "failed"; detail: string }

/**
 * "Make Default for this Folder" — the Tune section of this folder's `novaclaw.json`.
 *
 * `undefined` when this composer has no folder to write into (no server, or a draft with no
 * directory yet). The section is then simply absent rather than present-and-broken.
 */
export type ComposerMakeDefaultState = {
  /** The folder that would receive the file. Named on screen: never make someone guess the target. */
  folder: string
  /**
   * The project file that governs the folder TODAY, which may live in an ANCESTOR directory.
   *
   * ⚠️ The distinction is the whole reason this is a separate field from `folder`. Writing here when
   * an ancestor governs does not edit the ancestor — it creates a nearer file that takes over — and
   * a user who is not told that will read the receipt as having changed the file they were shown.
   */
  governedBy: ComposerProjectLayer | undefined
  /**
   * The DIRECTORY-keyed answer, for a draft chat that has no session to resolve a layer from.
   *
   * `undefined` means nobody has answered yet and is deliberately NOT the same as a `none` answer —
   * see `inForceState`.
   *
   * ⚠️ It is the fallback for the arms `governedBy` cannot cover: `none`, `invalid`, and an instance
   * too old to send the folder's fold. When the fold IS there, the draft's `governedBy` is built from
   * it and wins here, so this drives the "file exists, contents unknown" copy and nothing else.
   */
  discovered?:
    | { readonly kind: "project"; readonly root: string; readonly file: string }
    | { readonly kind: "invalid"; readonly file: string; readonly reason: string }
    | { readonly kind: "none" }
  /** `false` while a write is in flight; the button disables itself rather than queueing a second. */
  write: (features: Partial<Record<ComposerFeature, boolean>>) => Promise<ComposerMakeDefaultReceipt>
}

export type ComposerFeaturesControlState = {
  current: Record<ComposerFeature, boolean>
  override: Partial<Record<ComposerFeature, boolean>>
  /** Per switch, where the value came from when this chat did not set it. Absent = not yet known. */
  origin: Partial<Record<ComposerFeature, ComposerFeatureOrigin>>
  /** The `novaclaw.json` governing this chat's folder, when one does. */
  project: ComposerProjectLayer | undefined
  /** Writing this chat's stance into the folder's own `novaclaw.json`. */
  makeDefault: ComposerMakeDefaultState | undefined
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
  "memory",
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

/**
 * **"Make Default for this Folder"** — *"it creates `novaclaw.json` when absent,
 * or updates only its Tune section when present, preserving Permissions and unrelated fields; show
 * the resulting change and a local receipt."*
 *
 * 🔴 **It saves what THIS CHAT DECLARED, not every switch on screen.** The obvious implementation —
 * capture all eight effective values — writes a file that pins the folder against every later change
 * to the user's own Settings, which is exactly what `ProjectFile.Tune`'s "absent means INHERIT, never
 * off" discipline exists to prevent. So the payload is the chat's OVERRIDES: the switches the user
 * actually moved. Everything they left alone stays absent, and the folder keeps tracking Settings.
 * That is a surprising rule to meet in a receipt, so the section states it before the button and
 * lists the exact values it will write.
 *
 * ⚠️ The mode is deliberately not written. A project file may only ever say `interactive` (a folder
 * the user cloned five minutes ago must not start chats that prompt themselves), so a chat in an
 * unattended mode is told its mode stays with the chat rather than being silently dropped.
 */
function MakeDefaultSection(props: {
  state: ComposerMakeDefaultState
  overrides: Partial<Record<ComposerFeature, boolean>>
  mode: ComposerMode
  featureTitle: (name: string) => string
}) {
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  const [receipt, setReceipt] = createSignal<ComposerMakeDefaultReceipt | undefined>(undefined)

  /** What will be written, what will be dropped, and why — see `make-default.ts`. */
  const plan = () => planMakeDefault(props.overrides)
  const declared = () => plan().declared
  const omitted = () => plan().omitted
  const persisted = () => plan().persisted

  const describe = (entry: { feature: ComposerFeature; value: boolean }) =>
    `${props.featureTitle(entry.feature)} — ${language.t(`prompt.features.state.${entry.value ? "on" : "off"}`)}`

  /**
   * Where the folder's defaults come from TODAY. Principle 12(d): before the control, not after.
   *
   * The decision lives in `inForceState` so the six cases are assertable without a DOM — including
   * the draft case, where this sentence used to promise a creation in folders that already had a
   * file. The `pathKey` comparison (never `===`) is injected for the same reason it was here before.
   */
  const inForce = () => {
    const state = inForceState({
      folder: props.state.folder,
      governedBy: props.state.governedBy,
      discovered: props.state.discovered,
      samePath: (a, b) => pathKey(a) === pathKey(b),
    })
    switch (state.kind) {
      case "pending":
        return language.t("composer.tune.makeDefault.inForce.pending")
      case "none":
        return language.t("composer.tune.makeDefault.inForce.none")
      case "here":
        return language.t("composer.tune.makeDefault.inForce.here", { file: state.file })
      case "ancestor":
        return language.t("composer.tune.makeDefault.inForce.ancestor", { file: state.file })
      case "here-unknown":
        return language.t("composer.tune.makeDefault.inForce.hereUnknown", { file: state.file })
      // Deliberately the SAME sentence as a resolved ancestor. That copy already declines to say what
      // the file sets — it only says an ancestor governs and that saving takes over here — so knowing
      // `applied` would add nothing to it. A separate key would be two strings to keep in step for no
      // difference the user can see. The `here` pair DO differ, because that one offers to summarise.
      case "ancestor-unknown":
        return language.t("composer.tune.makeDefault.inForce.ancestor", { file: state.file })
      case "broken":
        return language.t(
          state.future
            ? "composer.tune.makeDefault.inForce.brokenFuture"
            : "composer.tune.makeDefault.inForce.brokenUnreadable",
          { file: state.file },
        )
    }
  }

  const run = () => {
    if (busy() || persisted().length === 0) return
    setBusy(true)
    setReceipt(undefined)
    void props.state
      .write(makeDefaultPayload(plan()))
      .then((result) => setReceipt(result))
      .catch((error) => setReceipt({ kind: "failed", detail: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false))
  }

  return (
    <div class="flex flex-col gap-1 border-t border-border-base pt-3" data-section="make-default">
      <span class="text-[13px] font-[560] text-v2-text-text-base">
        {language.t("composer.tune.makeDefault.title")}
        {/* The paragraph this control used to print in full, now on demand — hover, tap or focus. */}
        <SettingsExplainV2 label={language.t("composer.tune.makeDefault.title")}>
          {language.t("composer.tune.makeDefault.description.more")}
        </SettingsExplainV2>
      </span>
      <span class="text-[12px] leading-4 text-v2-text-text-faint">
        {language.t("composer.tune.makeDefault.description")}
      </span>
      <span class="text-[11px] leading-4 break-all text-v2-text-text-faint" data-make-default-inforce>
        {inForce()}
      </span>

      <Show
        when={declared().length > 0}
        fallback={
          <span class="text-[11px] leading-4 text-v2-text-text-faint" data-make-default-empty>
            {language.t("composer.tune.makeDefault.nothing")}
          </span>
        }
      >
        <Show when={persisted().length > 0}>
          <span class="text-[11px] leading-4 text-v2-text-text-faint" data-make-default-preview>
            {language.t("composer.tune.makeDefault.preview", { list: persisted().map(describe).join(", ") })}
          </span>
        </Show>
        <Show when={omitted().length > 0}>
          <span class="text-[11px] leading-4 text-v2-text-text-faint" data-make-default-omitted>
            {language.t("composer.tune.makeDefault.omitted", {
              list: omitted()
                .map((entry) => props.featureTitle(entry.feature))
                .join(", "),
            })}
          </span>
        </Show>
      </Show>

      <Show when={props.mode !== "interactive"}>
        <span class="text-[11px] leading-4 text-v2-text-text-faint" data-make-default-mode>
          {language.t("composer.tune.makeDefault.modeStays")}
        </span>
      </Show>

      <button
        type="button"
        data-action="make-default"
        class="mt-1 self-start rounded-md border border-border-base px-2.5 py-1 text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02 disabled:opacity-50"
        disabled={busy() || persisted().length === 0}
        onClick={run}
      >
        {language.t(busy() ? "composer.tune.makeDefault.saving" : "composer.tune.makeDefault.action")}
      </button>

      {/* THE LOCAL RECEIPT. It names the file that was written and the sections that changed, so the
          user can go and read the result rather than take our word for it. */}
      <Show when={receipt()}>
        {(result) => (
          <div
            class="flex flex-col gap-0.5 rounded-md border border-border-base px-2.5 py-1.5"
            data-make-default-receipt
          >
            <Switch>
              <Match
                when={
                  result().kind === "written"
                    ? (result() as Extract<ComposerMakeDefaultReceipt, { kind: "written" }>)
                    : undefined
                }
              >
                {(written) => (
                  <>
                    <span class="text-[12px] leading-4 break-all text-v2-text-text-base">
                      {language.t(
                        written().created
                          ? "composer.tune.makeDefault.receipt.created"
                          : "composer.tune.makeDefault.receipt.updated",
                        { file: written().file },
                      )}
                    </span>
                    <span class="text-[11px] leading-4 text-v2-text-text-faint">
                      {language.t("composer.tune.makeDefault.receipt.sections", {
                        list: written().sections.join(", "),
                      })}
                    </span>
                    <span class="text-[11px] leading-4 text-v2-text-text-faint">
                      {language.t("composer.tune.makeDefault.receipt.preserved")}
                    </span>
                    <Show when={written().refused.length > 0}>
                      <span class="text-[11px] leading-4 text-v2-text-text-faint">
                        {language.t("composer.tune.makeDefault.receipt.refused", {
                          list: written().refused.map(props.featureTitle).join(", "),
                        })}
                      </span>
                    </Show>
                  </>
                )}
              </Match>
              <Match
                when={
                  result().kind === "refused"
                    ? (result() as Extract<ComposerMakeDefaultReceipt, { kind: "refused" }>)
                    : undefined
                }
              >
                {(refused) => (
                  <>
                    {/* Two reasons, two opposite actions — "update NovaClaw" and "fix your file" —
                        so they never share a sentence. Same split the Settings screen makes. */}
                    <span class="text-[12px] leading-4 break-all text-v2-text-text-base">
                      {language.t(
                        refused().reason === "future-version"
                          ? "composer.tune.makeDefault.receipt.refusedFuture"
                          : "composer.tune.makeDefault.receipt.refusedBroken",
                        { file: refused().file, detail: refused().detail },
                      )}
                    </span>
                    <span class="text-[11px] leading-4 text-v2-text-text-faint">
                      {language.t("composer.tune.makeDefault.receipt.untouched")}
                    </span>
                  </>
                )}
              </Match>
              <Match
                when={
                  result().kind === "failed"
                    ? (result() as Extract<ComposerMakeDefaultReceipt, { kind: "failed" }>)
                    : undefined
                }
              >
                {(failed) => (
                  <span class="text-[12px] leading-4 text-v2-text-text-base">
                    {language.t("composer.tune.makeDefault.receipt.failed", { detail: failed().detail })}
                  </span>
                )}
              </Match>
            </Switch>
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
/**
 * OPEN the colleague's configuration for this chat — the panel formerly behind a "Tune" button.
 *
 * 🔴 **The button is gone; the chip that names the colleague opens this instead** (owner,
 * 2026-08-27: *"the 'which colleague this is for' icon … does nothing. Instead it should have the
 * agent name near it, and clicking any of them should open the Tune dialogue. The `Tune` button
 * itself is no longer needed."*). Two controls sat side by side in the composer — one showed WHO the
 * chat belongs to and did nothing, the other was a verb with no subject. Merging them costs a chip's
 * width and removes the question *"tune what?"*.
 *
 * ⚠️ Exported as an opener rather than a component because the trigger now lives in a different
 * control. Everything below it — `showScoped`, the roster refresh, `onClose` — is unchanged and each
 * line is load-bearing for a reason recorded at its own site.
 */
export function useTunePanelOpener(state: () => ComposerFeaturesControlState) {
  const props = {
    get state() {
      return state()
    },
  }
  return composerTunePanel(props)
}

function composerTunePanel(props: { state: ComposerFeaturesControlState }) {
  // The ONE shared roster, refreshed after a Tune save — see the dialog mount below for why. Resolved
  // here rather than threaded in as a prop: it is a singleton per connection, so every surface that
  // needs it reaches for the same one, and a prop would make each caller responsible for remembering.
  const rosterServer = useServer()
  const rosterGlobal = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
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
  // 🔴 Tune now opens the COLLEAGUE'S CONFIG, with this chat's controls as a section inside it
  // (AGENTS.md — the structural metaphor). The old panel said settings belong to a conversation;
  // under the roster they belong to whoever you are talking to, and only "how this chat runs" is
  // the conversation's own. Same dialog the Contacts app opens, so there is one place to learn.
  //
  // `showScoped` is unchanged and still load-bearing — see the note below on the mis-targeted write.
  //
  // ⚠️ `onDismiss` CLOSES THE DIALOG, it does not merely fire the composer's hook. It used to call
  // only `props.state.onClose()`, which re-reads the session record and leaves the panel standing —
  // so Close and Cancel did nothing visible. That went unnoticed because the panel was closing by
  // accident on every click (it rendered a bare `<div>` under the stack's `pointer-events: none`
  // layer, so clicks fell through to the overlay). Fixing the modal made the dead button visible.
  // `stack.close` runs the `onClose` passed below, so the composer's hook still fires exactly once.
  const openPanel = () =>
    void dialog.showScoped(
      () => (
        <AgentConfigDialog
          agentID={props.state.agent}
          // 🔴 It DOES refresh the roster, and the comment that used to sit here explains why nobody
          // noticed: *"opened from a CHAT, there is no roster on screen to refresh."* That was true
          // until the composer's own agent chip started reading the roster for a display NAME. After
          // that, renaming a colleague here left the chip showing the old one — so the save looked
          // like it had failed, which is the one impression `agentConfig.saveFailed` exists to
          // reserve for saves that actually did.
          onChanged={() => {
            const conn = rosterServer.current
            if (conn) rosterGlobal.ensureServerCtx(conn).agents.refetch()
          }}
          onDismiss={() => dialog.close()}
          tuning={() => <TuningPanel state={props.state} onDismiss={() => dialog.close()} embedded />}
        />
      ),
      () => props.state.onClose(),
    )
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
function TuningPanel(props: { state: ComposerFeaturesControlState; onDismiss: () => void; embedded?: boolean }) {
  /**
   * The one line under each switch that says WHY it reads the way it does.
   *
   * Order matters and is not arbitrary: this chat's own choice outranks everything, so it is checked
   * first; below that the folder outranks the instance, matching the resolution the kernel actually
   * runs (`session/effective-config.ts`). Falling back to the instance wording when the origin is
   * not loaded yet is deliberate — it is what the panel said before, so a slow request degrades to
   * the previous behaviour instead of to a blank line.
   */
  const featureSource = (feature: ComposerFeature) => {
    const state = language.t(`prompt.features.state.${props.state.current[feature] ? "on" : "off"}`)
    if (props.state.override[feature] !== undefined) return language.t("prompt.features.source.override")
    const origin = props.state.origin[feature]
    if (origin?.kind === "project") return language.t("prompt.features.source.project", { state })
    if (origin?.kind === "session") return language.t("prompt.features.source.parent", { state })
    return language.t("prompt.features.source.inherit", { state })
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
      {/*
          THE FOLDER'S OWN LAYER, named. `notes/spec` calls a project file a layer BENEATH the chat:
          it supplies what no chat declared and loses to every chat that did. That is invisible in a
          list of switches, so the panel says it out loud — the file, what it set, and what it asked
          for and did not get.
        */}
      <Show when={props.state.project}>
        {(project) => (
          <div class="flex flex-col gap-0.5" data-section="project-tune">
            <span class="text-[13px] font-[560] text-v2-text-text-base">{language.t("prompt.project.title")}</span>
            <span class="text-[12px] leading-4 break-all text-v2-text-text-faint" data-project-file>
              {project().file}
            </span>
            <Show
              when={project().applied.length > 0}
              fallback={
                <span class="text-[11px] leading-4 text-v2-text-text-faint">{language.t("prompt.project.none")}</span>
              }
            >
              <span class="text-[11px] leading-4 text-v2-text-text-faint" data-project-applied>
                {language.t("prompt.project.applied", {
                  list: project().applied.map(featureTitle).join(", "),
                })}
              </span>
            </Show>
            <Show when={project().refused.length > 0}>
              <span class="text-[11px] leading-4 text-v2-text-text-faint" data-project-refused>
                {language.t("prompt.project.refused", {
                  list: project().refused.map(featureTitle).join(", "),
                })}
              </span>
            </Show>
          </div>
        )}
      </Show>
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
            <span class="text-[11px] leading-4 text-v2-text-text-faint" data-feature-source>
              {featureSource(feature)}
            </span>
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
      <Show when={props.state.makeDefault}>
        {(makeDefault) => (
          <MakeDefaultSection
            state={makeDefault()}
            overrides={props.state.override}
            mode={props.state.mode}
            featureTitle={featureTitle}
          />
        )}
      </Show>
    </div>
  )
  return props.embedded ? body : <Dialog size="content">{body}</Dialog>
}
