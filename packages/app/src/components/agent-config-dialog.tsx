import type { ConfigV2Agent } from "@novaclaw/sdk/v2/client"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch as SwitchToggle } from "@novaclaw/ui/v2/switch-v2"
import { ControlScope } from "@/components/control-scope"
import { useConfirm } from "@/components/dialog-confirm"
import { useDirectoryPicker } from "@/components/directory-picker"
import { displayName as folderDisplayName } from "@/pages/layout/helpers"
import { Icon } from "@novaclaw/ui/v2/icon"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { downloadPlainText, sessionExportFilename } from "@/components/session/session-context-export"
import { listSessions, startChat } from "@/apps/agent-list"
import { OfficerPrompt } from "@novaclaw/core/officer-prompt"
import { modelRef, parseModelRef } from "@/apps/agent-model"
import { useModels } from "@/context/models"
import { cloneAgent, isNovaCloneRefusal } from "@/apps/agent-clone"
import { chatFor, chatToClear, rootsToClear } from "@/apps/roster-live"
import {
  GOVERNING_ID,
  displayName,
  isColleague,
  memoryDisclosure,
  superiorCandidates,
  type AgentLike,
} from "@/apps/contacts"
import { ownerRoute } from "@/apps/memory-owner"
import { worldMemoryClearScopeVerified } from "@/utils/memory-api"
import { useLocation, useNavigate } from "@solidjs/router"
import { AgentPortrait } from "@/components/agent-portrait"
import { AGENT_AVATAR_TYPES, removeAgentAvatar, uploadAgentAvatar } from "@/apps/agent-avatar"
import { isAgentPortraitURL } from "@/apps/agent-portrait"
import { AgentHelpDialog } from "@/components/agent-help-dialog"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { tabHref, useTabs } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { SettingsNudgesV2 } from "@/components/settings-v2/nudges"
import { AgentRemoteChat } from "@/components/agent-remote-chat"
import { PERSONALITY_FORMAT, downloadOfficerPersonality, parseOfficerPersonality } from "@/apps/agent-personality"
import { switchType } from "@/utils/fs-api"
import { createSettledResource } from "@/utils/settled-resource"
import {
  classify,
  classifyRequirement,
  isBelow,
  REQUIREMENTS,
  taxonomyLabel,
  type Requirement,
} from "@/components/model-taxonomy"

const POSTURE_CHOICES: ("agent" | "chat")[] = ["agent", "chat"]
const PERMISSION_MODE_CHOICES: ("plan" | "bypass" | "yolo")[] = ["plan", "bypass", "yolo"]

// ONE addressable officer-settings screen, opened from two places (AGENTS.md → *the structural metaphor*;
// `notes/named-agents.md`).
//
// 🔴 **This is where the composer's Tune button now leads.** Tune used to be a chat-scoped popover
// under the message box, which said the quiet part: settings belonged to a *conversation*. Under the
// roster they belong to a *colleague* — its brief, its personality, what it remembers — and the chat
// only carries how this particular conversation runs. So the button opens the colleague's config,
// with the chat's own controls as a section inside it rather than the whole of it.
//
// ⚠️ **A field the system would discard is not rendered as editable.** What makes a field
// discardable is the RULE, not the colleague: an agent's own `configure` tool may not rewrite the
// governing agent's charter, so that arm is closed where writes happen. The operator's surface is a
// different actor, and Nova is edited here exactly as any other officer is — with exactly three
// things absent, because the store refuses them: no project folder, no clone, no retirement
// (owner ruling 2026-09-15). Offering an input whose value goes nowhere is worse than offering
// nothing: the user does the work, sees no error, and learns not to trust the surface.

export function AgentConfigScreen(props: {
  /** Which colleague. `undefined` while a chat is still resolving its agent. */
  agentID: string | undefined
  onDismiss: () => void
  /**
   * Something about the roster CHANGED — a hire, a retirement, a cleared chat, a saved profile.
   *
   * ⚠️ The screen cannot refetch the list it was opened from, and without this it does not try:
   * measured 2026-08-21, retiring a colleague removed it from the server and left its row on screen
   * until a manual reload. The durable change with the stale view, one more time.
   */
  onChanged?: () => void
  /** The chat-scoped controls, when this was opened from a conversation. Absent from Contacts: there
   *  is no chat to tune, and rendering an empty section would imply one. */
  tuning?: () => JSX.Element
}) {
  const language = useLanguage()
  const dialogStack = useDialog()
  const tabs = useTabs()
  /** The tab strip is keyed by SERVER + session, so closing one needs the connection's key. */
  const serverKey = () => {
    const current = conn()
    return current ? ServerConnection.key(current) : undefined
  }
  const confirm = useConfirm()
  const navigate = useNavigate()
  const location = useLocation()
  const pickDirectory = useDirectoryPicker()
  const global = useGlobal()
  const server = useServer()
  const sync = useServerSync()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })
  // 🔴 The server context's ONE shared roster — this dialog used to fetch `GET /api/agent` again on
  // EVERY open (review D8), and that in-flight window is what made D3 possible: `agent()` was
  // `undefined` for a moment on a page that had the data on screen a second earlier, so a Save fired
  // in that window wrote the colleague's brief away as `""`. It also carries the `.catch` this call
  // site was missing (D1) — a rejected resource read from the eager memo below reached the app's one
  // ErrorBoundary, at its root, and replaced the whole UI.
  const agents = () => ctx()?.agents.list()
  const agent = createMemo<AgentLike | undefined>(() => (agents() ?? []).find((row) => row.id === props.agentID))

  const governing = createMemo(() => props.agentID === GOVERNING_ID)

  const name = createMemo(() => agent()?.name?.trim() || (props.agentID ? displayName(props.agentID) : ""))

  // Drafts start empty and fall back to the stored value at render, so an edit survives a re-read of
  // the roster while an untouched field keeps tracking the server.
  const [renamed, setRenamed] = createSignal<string | undefined>()
  const [title, setTitle] = createSignal<string | undefined>()
  const [personality, setPersonality] = createSignal<string | undefined>()
  const [job, setJob] = createSignal<string | undefined>()
  const [avatarFile, setAvatarFile] = createSignal<File | undefined>()
  const [avatarRemoved, setAvatarRemoved] = createSignal(false)
  const [memory, setMemory] = createSignal<"own" | "none" | undefined>()
  const [archive, setArchive] = createSignal<boolean | undefined>()
  const [model, setModel] = createSignal<string | undefined>()
  const [reasoningModel, setReasoningModel] = createSignal<string | undefined>()
  const [workerModel, setWorkerModel] = createSignal<string | undefined>()
  const [reasoningBudget, setReasoningBudget] = createSignal<string | undefined>()
  const [maxToolTimeoutMinutes, setMaxToolTimeoutMinutes] = createSignal<string | undefined>()
  const [workerPrototype, setWorkerPrototype] = createSignal<string | undefined>()
  const [maxWorkers, setMaxWorkers] = createSignal<string | undefined>()
  const [spawnDepth, setSpawnDepth] = createSignal<string | undefined>()
  const [runtimeHeartbeatMinutes, setRuntimeHeartbeatMinutes] = createSignal<string | undefined>()
  const [needsTaxonomy, setNeedsTaxonomy] = createSignal<string | undefined>()
  const [superior, setSuperior] = createSignal<string | undefined>()
  // `""` is a real value here and means "back to its own scratch" — distinct from `undefined`, which
  // means "the user has not touched this field". Collapsing the two would make Clear indistinguishable
  // from Cancel.
  const [directory, setDirectory] = createSignal<string | undefined>()
  const [posture, setPosture] = createSignal<boolean | undefined>()
  const [permissionMode, setPermissionMode] = createSignal<string | undefined>()
  const [strict, setStrict] = createSignal<boolean | undefined>()
  const [operationMode, setOperationMode] = createSignal<"interactive" | "unattended" | undefined>()
  const [goal, setGoal] = createSignal<string | undefined>()
  const [contextBudget, setContextBudget] = createSignal<boolean | undefined>()
  const [surgicalEdits, setSurgicalEdits] = createSignal<boolean | undefined>()
  const [introspection, setIntrospection] = createSignal<boolean | undefined>()
  const [quality, setQuality] = createSignal<boolean | undefined>()
  const [affective, setAffective] = createSignal<boolean | undefined>()
  /**
   * Tool-call captions, drafted as the OPT-OUT. `undefined` = untouched; ON is the default, so a
   * stored `false` is the only way this colleague stops paying a model call per shell command for a
   * caption that never reaches the model.
   */
  const [toolLabels, setToolLabels] = createSignal<boolean | undefined>()
  /**
   * Load the working folder's ambient instructions (`AGENTS.md`), drafted as the OPT-IN. `undefined` =
   * untouched; the default is OFF, so `true` is the only value that turns it on and a stored `false`
   * is only ever a user's explicit decline. Owner, 2026-09-17.
   */
  const [instructions, setInstructions] = createSignal<boolean | undefined>()
  /**
   * Computer Use, drafted as the OPT-OUT rather than as the permission. `undefined` = untouched;
   * `true` = hand the officer back to the floor's grant (the rule goes away); `false` = store the deny.
   * Absence means ON, so there is exactly one place that says whether an officer can touch the
   * desktop — the floor in `core/src/plugin/agent.ts` — and a stored rule exists only to refuse.
   */
  const [computerUse, setComputerUse] = createSignal<boolean | undefined>()
  const models = useModels()
  const [saving, setSaving] = createSignal(false)
  type SettingsTab = "profile" | "mind" | "work" | "nudges" | "memory" | "workers" | "io" | "chat"
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("profile")
  const settingsTabs = createMemo(() => [
    { id: "profile" as const, label: "Profile", icon: "user" as const },
    { id: "mind" as const, label: "Mind", icon: "brain" as const },
    { id: "work" as const, label: "Work", icon: "task" as const },
    { id: "nudges" as const, label: "Nudges", icon: "prompt" as const },
    { id: "memory" as const, label: "Memory", icon: "archive" as const },
    { id: "workers" as const, label: "Workers", icon: "branch" as const },
    { id: "io" as const, label: "Input / Output", icon: "chats" as const },
    ...(props.tuning ? [{ id: "chat" as const, label: "This chat", icon: "chats" as const }] : []),
  ])
  /**
   * ⚠️ Through the dialog STACK, not as a nested `<Dialog>`. The first attempt rendered
   * `<AgentHelpDialog>` inside this component's tree and nothing appeared: the shell's content is a
   * Kobalte `Dialog.Content`, which needs the root the stack provides, so a second one mounted inline
   * has no context to attach to. `showScoped` also binds its life to this component, so closing Tune
   * cannot leave Help orphaned above an empty screen.
   */
  const openHelp = () => void dialogStack.showScoped(() => <AgentHelpDialog onDismiss={() => dialogStack.close()} />)

  const nameValue = () => renamed() ?? agent()?.name ?? (props.agentID ? displayName(props.agentID) : "")
  const titleValue = () => title() ?? agent()?.title ?? ""
  const personalityValue = () => personality() ?? agent()?.personality ?? ""
  // 🔴 The box SHOWS the prompt that will actually run (owner, 2026-09-17). An officer with no stored
  // prompt falls back to `OfficerPrompt.DEFAULT_OFFICER_PROMPT` at runtime, so the box shows that same
  // text rather than an empty field with an invisible default behind it. Clearing it to "" is a real
  // choice: an empty prompt is an empty prompt, and the model receives no identity block.
  const jobValue = () => job() ?? agent()?.system ?? OfficerPrompt.DEFAULT_OFFICER_PROMPT
  // A chat-mode colleague (posture `shortChat`) DEFAULTS off: the runner's own gate
  // (`maintenance.ts` — `ShortChat.enabled(config.shortChat) || !stanceOf("memory", ...)`) never
  // records a thing for it, so an ON toggle there would be a promise the stance cannot keep. Every
  // other colleague defaults ON — one that cannot learn its work is not much of a colleague. A
  // stored value always wins over this default, so nothing here rewrites an explicit choice.
  const memoryValue = () => memory() ?? agent()?.memory ?? (postureValue() ? "none" : "own")
  const directoryValue = () => {
    const draft = directory()
    if (draft !== undefined) return draft.trim() === "" ? undefined : draft
    const stored = (agent()?.config?.["directory"] as string | undefined)?.trim()
    return stored ? stored : undefined
  }
  // Each reads the DRAFT first, then the colleague's stored value, then the shipped baseline — the
  // same "absent means inherit" the config layer itself uses, so the dialog shows what a chat with
  // this colleague would actually start with.
  const postureValue = () => posture() ?? (agent()?.config?.["shortChat"] as boolean | undefined) ?? false
  const permissionModeValue = () =>
    permissionMode() ?? (agent()?.config?.["permissionMode"] as string | undefined) ?? "bypass"
  const strictValue = () =>
    strict() ?? (agent()?.config?.["strict"] as { enabled?: boolean } | undefined)?.enabled ?? false
  // ⚠️ DEFAULT INTERACTIVE (owner ruling 2026-09-15). This read `=== "interactive" ? "interactive" :
  // "unattended"`, i.e. anything not explicitly interactive — including "never set" — displayed as
  // Unattended. So a colleague nobody had configured showed a switch in the ON position for a mode
  // it was not actually in, and the person reading it had no way to tell "chosen" from "unset".
  const operationModeValue = () =>
    operationMode() ??
    ((agent()?.config?.["operationMode"] as string | undefined) === "unattended" ? "unattended" : "interactive")
  const goalValue = () => goal() ?? (agent()?.config?.["goal"] as string | undefined) ?? ""
  // The settings shell can render before the first config snapshot arrives (and the lightweight
  // browser fixtures deliberately exercise that state). Missing instance config means shipped
  // defaults, never a reason for the officer screen to crash.
  const instanceConfig = () => (sync().data.config ?? {}) as Record<string, unknown>
  const instanceEnabled = (block: string, fallback: boolean) => {
    const value = instanceConfig()[block]
    return typeof value === "object" && value !== null && "enabled" in value
      ? ((value as { enabled?: boolean }).enabled ?? fallback)
      : fallback
  }
  const standingValue = (draft: boolean | undefined, key: string, fallback: boolean) =>
    draft ?? (agent()?.config?.[key] as boolean | undefined) ?? fallback
  const contextBudgetValue = () => standingValue(contextBudget(), "contextBudget", instanceEnabled("context", true))
  const surgicalEditsValue = () => standingValue(surgicalEdits(), "surgicalEdits", false)
  const introspectionValue = () =>
    standingValue(introspection(), "introspection", instanceEnabled("introspection", false))
  const qualityValue = () => standingValue(quality(), "quality", instanceEnabled("quality", false))
  const affectiveValue = () => standingValue(affective(), "affective", instanceEnabled("affective", false))

  // ── Computer Use ───────────────────────────────────────────────────────────────────────────────
  // The switch reads a PERMISSION RULE, not a field of its own, on purpose. A `computerUse: boolean`
  // on the agent would be a second answer to "may this officer touch the desktop", stored beside the
  // rule that actually decides it, and the two would drift. The rule is the truth; this is its face.
  type StoredRule = { readonly action: string; readonly resource: string; readonly effect: string }
  const storedRules = (): readonly StoredRule[] => {
    const raw = agent()?.config?.["permissions"]
    return Array.isArray(raw) ? (raw as StoredRule[]) : []
  }
  /** Opted out means a `deny` on `*` specifically. Anything narrower is the user's own rule. */
  const computerOptedOut = () =>
    storedRules().some((rule) => rule.action === "computer" && rule.resource === "*" && rule.effect === "deny")
  const computerUseValue = () => computerUse() ?? !computerOptedOut()
  /**
   * The ruleset to store, with the officer's and the user's other rules riding along untouched.
   *
   * `resource: "*"` is load-bearing twice over: `ToolRegistry` withdraws a tool from the model's
   * horizon only on a `*` deny (a narrower one leaves ~2 KB of schema in every turn for a tool that
   * cannot be called), and `tool/computer.ts` asserts the action a second time as
   * `bind-windows-app/<exe>`, which a narrow grant would pass the first check and refuse the second.
   * Turning it back ON deletes the rule rather than writing an `allow`: the floor is what grants it,
   * and a stored allow would outlive the floor it was compensating for.
   */
  const computerRuleset = () => {
    const kept = storedRules().filter(
      (rule) => !(rule.action === "computer" && rule.resource === "*" && rule.effect === "deny"),
    )
    return computerUse() === false
      ? [...kept, { action: "computer", resource: "*", effect: "deny" } satisfies StoredRule]
      : kept
  }
  /**
   * Where this colleague's own workspace is, as the server computed it.
   *
   * ⚠️ Read from the AGENT record rather than derived here: the scratch root lives under the
   * instance's data directory, which this client does not know. A guess would produce a link to a
   * folder that does not exist, which is worse than no link.
   */
  const workspacePath = () => {
    const raw = (agent() as unknown as { readonly workspace?: unknown } | undefined)?.workspace
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
  }

  const folderLabel = () => {
    const folder = directoryValue()
    return folder ? folderDisplayName({ worktree: folder }) : language.t("agentConfig.folderScratch")
  }
  const pickFolder = () => {
    const current = conn()
    if (current === undefined) return
    pickDirectory({
      server: current,
      title: language.t("agentConfig.folderPick"),
      onSelect: (result) => {
        const picked = Array.isArray(result) ? result[0] : result
        if (picked) setDirectory(picked)
      },
    })
  }
  // Default ON — `undefined` means on, per the owner's "unless the settings disable it".
  const archiveValue = () => archive() ?? agent()?.archiveChats ?? true
  // Default ON, exactly like `archiveChats`: absent means on, and only an explicit `false` skips the
  // per-tool-call captioning request.
  const toolLabelsValue = () => toolLabels() ?? agent()?.toolLabels ?? true
  // Default OFF — opt-in: absent means this colleague loads no AGENTS.md.
  const instructionsValue = () => instructions() ?? agent()?.instructions ?? false
  // "" is the INHERIT choice, and it is a real value rather than a missing one: a colleague with no
  // model of its own follows the instance default, which is a decision the user can return to.
  const modelValue = () => {
    const chosen = model()
    if (chosen !== undefined) return chosen
    const bound = agent()?.model
    return bound ? modelRef(bound) : ""
  }
  const reasoningModelValue = () => {
    const chosen = reasoningModel()
    if (chosen !== undefined) return chosen
    const stored = agent()?.config?.["reasoningModel"]
    return typeof stored === "string" ? stored : ""
  }
  const workerModelValue = () => {
    const chosen = workerModel()
    if (chosen !== undefined) return chosen
    const stored = agent()?.config?.["workerModel"]
    return typeof stored === "string" ? stored : ""
  }
  // 🔴 `enabled` is EXACTLY the predicate the kernel resolves a turn through: a switched-off model is
  // not in `catalog.model.available()`, so a turn on it is substituted. Offering it as a new pick
  // here is a control that lies — the user chooses it, the save succeeds, and the officer runs on
  // something else. So the picker offers only RUNNABLE models (owner, 2026-09-15).
  //
  // ⚠️ The officer's OWN stored choice still renders even when it is not runnable — labelled, with
  // the help line below the picker — because the alternative is the picker displaying "Default
  // Model" while the stored setting says otherwise, which is the same lie from the other side.
  // Nothing here RE-ENABLES a model: only the owner may, from Settings → Models.
  const runnableModels = createMemo(() =>
    models.list().filter((item) => models.enabled({ providerID: item.provider.id, modelID: item.id })),
  )
  const modelChoice = (item: {
    readonly provider: { readonly id: string }
    readonly id: string
    readonly name?: string
  }) => ({
    key: modelRef({ providerID: item.provider.id, id: item.id }),
    value: modelRef({ providerID: item.provider.id, id: item.id }),
    label: item.name ?? item.id,
  })
  /**
   * Why the model this officer is SET TO will not run here — or `undefined` when it will.
   *
   * `switched-off` and `unavailable` are kept apart because they are different repairs: the first is
   * a switch only the owner may flip (Settings → Models), the second resolves itself when the
   * provider returns.
   */
  const blockedKind = (value: string): "switched-off" | "unavailable" | undefined => {
    if (value === "") return undefined
    const ref = parseModelRef(value)
    if (ref === undefined) return undefined
    const listed = models.list().some((item) => item.provider.id === ref.providerID && item.id === ref.id)
    if (!listed) return "unavailable"
    if (!models.enabled({ providerID: ref.providerID, modelID: ref.id })) return "switched-off"
    return undefined
  }
  const modelBlocked = createMemo<
    { readonly value: string; readonly kind: "switched-off" | "unavailable" } | undefined
  >(() => {
    const value = modelValue()
    const kind = blockedKind(value)
    return kind === undefined ? undefined : { value, kind }
  })
  /** Append the current value when it is not among the runnable options, so the select can show it. */
  const withBlockedCurrent = (options: { key: string; value: string; label: string }[], current: string) => {
    // ⚠️ An EMPTY catalog is "not loaded yet", not "your model is gone". Appending a badged entry
    // during the cold-start window would flash an unavailable label at every open — and the D2
    // race test pins that the pre-catalog state reads as the inherit placeholder, then resolves.
    if (models.list().length === 0) return options
    if (current === "" || options.some((option) => option.value === current)) return options
    return [
      ...options,
      {
        key: current,
        value: current,
        label:
          blockedKind(current) === "switched-off"
            ? language.t("agentConfig.modelSwitchedOff", { model: current })
            : language.t("agentConfig.modelUnavailable", { model: current }),
      },
    ]
  }
  const modelOptions = createMemo(() =>
    withBlockedCurrent(
      [
        { key: "inherit", value: "", label: language.t("agentConfig.modelInherit") },
        ...runnableModels().map(modelChoice),
      ],
      modelValue(),
    ),
  )
  const reasoningModelOptions = createMemo(() =>
    withBlockedCurrent(
      [{ key: "ordinary", value: "", label: "Use the ordinary model" }, ...runnableModels().map(modelChoice)],
      reasoningModelValue(),
    ),
  )
  const workerModelOptions = createMemo(() =>
    withBlockedCurrent(
      [{ key: "officer", value: "", label: "Use this officer’s model" }, ...runnableModels().map(modelChoice)],
      workerModelValue(),
    ),
  )
  const workerPrototypeValue = () => {
    const chosen = workerPrototype()
    if (chosen !== undefined) return chosen
    const stored = agent()?.config?.["workerPrototype"]
    return typeof stored === "string" ? stored : ""
  }
  const workerPrototypeOptions = createMemo(() => [
    { key: "default", value: "", label: "Use this officer’s recipe" },
    ...(agents() ?? [])
      .filter(
        (candidate) =>
          candidate.id !== props.agentID &&
          candidate.id !== "nova" &&
          isColleague(candidate) &&
          candidate.paused !== true,
      )
      .map((candidate) => ({
        key: candidate.id,
        value: candidate.id,
        label: `${candidate.name?.trim() || displayName(candidate.id)} · ${candidate.title ?? language.t("agentConfig.noTitle")}`,
      })),
  ])
  const integerValue = (draft: string | undefined, key: string, fallback: number) => {
    if (draft !== undefined) return draft
    const stored = agent()?.config?.[key]
    return typeof stored === "number" ? String(stored) : String(fallback)
  }
  const maxWorkersValue = () => integerValue(maxWorkers(), "maxWorkers", 100)
  const spawnDepthValue = () => integerValue(spawnDepth(), "spawnDepth", 1)
  const parseNonNegative = (value: string) => {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN
  }
  const parsedMaxWorkers = () => parseNonNegative(maxWorkersValue())
  const parsedSpawnDepth = () => parseNonNegative(spawnDepthValue())
  const runtimeHeartbeatMinutesValue = () => integerValue(runtimeHeartbeatMinutes(), "runtimeHeartbeatMinutes", 60)
  const parsedRuntimeHeartbeatMinutes = () => {
    const parsed = Number(runtimeHeartbeatMinutesValue())
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN
  }
  const reasoningBudgetValue = () => {
    const chosen = reasoningBudget()
    if (chosen !== undefined) return chosen
    const stored = (agent()?.config as Record<string, unknown> | undefined)?.["reasoningBudget"]
    return typeof stored === "number" ? String(stored) : ""
  }
  const parsedReasoningBudget = () => {
    const value = reasoningBudgetValue().trim()
    if (value === "") return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN
  }
  const reasoningBudgetValid = () => !Number.isNaN(parsedReasoningBudget())
  const maxToolTimeoutMinutesValue = () => {
    const chosen = maxToolTimeoutMinutes()
    if (chosen !== undefined) return chosen
    const stored = (agent()?.config as Record<string, unknown> | undefined)?.["maxToolTimeoutMs"]
    return typeof stored === "number" ? String(stored / 60_000) : ""
  }
  const parsedMaxToolTimeoutMs = () => {
    const value = maxToolTimeoutMinutesValue().trim()
    if (value === "") return undefined
    const milliseconds = Number(value) * 60_000
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : Number.NaN
  }
  const maxToolTimeoutValid = () => !Number.isNaN(parsedMaxToolTimeoutMs())
  const superiorValue = () => superior() ?? agent()?.superior ?? ""
  const boundTaxonomy = createMemo(() => {
    const ref = parseModelRef(modelValue())
    if (ref === undefined) return undefined
    const found = models.list().find((item) => item.id === ref.id && item.provider.id === ref.providerID) as
      | { taxonomy?: string }
      | undefined
    return found === undefined ? undefined : classify(found.taxonomy)
  })
  /**
   * The value for "no requirement declared".
   *
   * ⚠️ NOT the empty string. Kobalte's Select builds an option's key from `optionValue`, and an empty
   * key is dropped from the collection — measured 2026-09-16: the `""` option never rendered, so the
   * control had no way back to "No requirement". A named sentinel is also what the user reads.
   */
  const NO_REQUIREMENT = "none"
  const requirementOptions: readonly (Requirement | typeof NO_REQUIREMENT)[] = [NO_REQUIREMENT, ...REQUIREMENTS]
  /** `NO_REQUIREMENT` when nothing is declared; `undefined` means the user has not touched it. */
  const needsTaxonomyValue = (): Requirement | typeof NO_REQUIREMENT => {
    const chosen = needsTaxonomy()
    if (chosen !== undefined) return classifyRequirement(chosen) ?? NO_REQUIREMENT
    const declared = (agent()?.config as Record<string, unknown> | undefined)?.["needsTaxonomy"]
    return typeof declared === "string" ? (classifyRequirement(declared) ?? NO_REQUIREMENT) : NO_REQUIREMENT
  }
  const superiorOptions = createMemo(() => [
    { key: "nova", value: "", label: language.t("agentConfig.superiorNova") },
    ...superiorCandidates(agents() ?? [], props.agentID ?? "").map((candidate) => ({
      key: candidate.id,
      value: candidate.id,
      label: `${candidate.name?.trim() || displayName(candidate.id)} · ${candidate.title ?? language.t("agentConfig.noTitle")}`,
    })),
  ])
  /** Is the model bound above ALREADY beneath the class chosen here? Shown live, in the dialog where
   *  both choices are made — the colleague's own notice arrives in its chat, which is the right place
   *  for the model but the wrong place for the person setting this up. */
  const belowFloor = createMemo(() => {
    const needs = classifyRequirement(needsTaxonomyValue())
    const bound = boundTaxonomy()
    return needs !== undefined && bound !== undefined && isBelow(bound, needs)
  })
  const dirty = () =>
    renamed() !== undefined ||
    title() !== undefined ||
    personality() !== undefined ||
    job() !== undefined ||
    memory() !== undefined ||
    directory() !== undefined ||
    posture() !== undefined ||
    permissionMode() !== undefined ||
    strict() !== undefined ||
    operationMode() !== undefined ||
    goal() !== undefined ||
    contextBudget() !== undefined ||
    surgicalEdits() !== undefined ||
    introspection() !== undefined ||
    quality() !== undefined ||
    affective() !== undefined ||
    toolLabels() !== undefined ||
    instructions() !== undefined ||
    computerUse() !== undefined ||
    archive() !== undefined ||
    needsTaxonomy() !== undefined ||
    model() !== undefined ||
    reasoningModel() !== undefined ||
    workerModel() !== undefined ||
    reasoningBudget() !== undefined ||
    maxToolTimeoutMinutes() !== undefined ||
    workerPrototype() !== undefined ||
    maxWorkers() !== undefined ||
    spawnDepth() !== undefined ||
    runtimeHeartbeatMinutes() !== undefined ||
    superior() !== undefined ||
    avatarFile() !== undefined ||
    avatarRemoved()

  const [busy, setBusy] = createSignal<"clone" | "clear" | "clear-memory" | "retire" | "pause" | undefined>()

  // The shared roster is also used by render/offline states that deliberately have no SDK yet.
  // Treat that as "not connected", not as a component crash during construction.
  const sdk = () => ctx()?.sdk?.client?.v2
  const [sessionRows, sessionActions] = createSettledResource(sdk, (client) => listSessions(client))
  const [createdSessionID, setCreatedSessionID] = createSignal<string | undefined>()
  const officerSessionID = () =>
    createdSessionID() ?? (props.agentID === undefined ? undefined : chatFor(sessionRows() ?? [], props.agentID)?.id)
  // Export the officer's captured INIT prompt: the first request the runner sent for its chat, which
  // ends at the first user message. Absent until that chat has dispatched a turn.
  const exportOfficerPrompt = async () => {
    const sessionID = officerSessionID()
    const client = sdk()
    if (sessionID === undefined || client === undefined) {
      showToast({ variant: "default", title: language.t("context.export.promptEmpty") })
      return
    }
    try {
      const response = await client.session.promptSource({ sessionID })
      const initial = response.data?.data?.initial
      if (initial === undefined) {
        showToast({ variant: "default", title: language.t("context.export.promptEmpty") })
        return
      }
      downloadPlainText(sessionExportFilename(name(), "prompt"), initial)
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const ensureOfficerSession = async () => {
    const current = officerSessionID()
    if (current) return current
    const client = sdk()
    const id = props.agentID
    if (!client || !id) return undefined
    const created = await startChat(client, { agentID: id, title: name() })
    if (created) {
      setCreatedSessionID(created)
      void sessionActions.refetch()
    }
    return created
  }

  let personalityInput: HTMLInputElement | undefined
  const exportPersonality = () => {
    const slug =
      nameValue()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "officer"
    downloadOfficerPersonality(`${slug}-personality.json`, {
      format: PERSONALITY_FORMAT,
      version: 1,
      profile: {
        name: nameValue(),
        title: titleValue(),
        personality: personalityValue(),
        job: jobValue(),
      },
    })
  }
  const importPersonality = async (file: File | undefined) => {
    if (!file) return
    const parsed = parseOfficerPersonality(await file.text())
    if (!parsed) {
      showToast({ variant: "error", title: "That is not a NovaClaw officer personality file" })
      return
    }
    if (parsed.profile.name !== undefined) setRenamed(parsed.profile.name)
    if (parsed.profile.title !== undefined) setTitle(parsed.profile.title)
    if (parsed.profile.personality !== undefined) setPersonality(parsed.profile.personality)
    if (parsed.profile.job !== undefined) setJob(parsed.profile.job)
    showToast({ variant: "success", title: "Personality loaded — review it, then Save" })
  }

  /** Hire a copy: same brief, new identity (`apps/agent-clone.ts`). */
  const clone = async () => {
    const source = agent()
    if (source === undefined) return
    setBusy("clone")
    try {
      const plan = await cloneAgent({
        source,
        roster: agents() ?? [],
        random: Math.random,
        updateConfig: (patch) => sync().updateConfig(patch as never),
      })
      showToast({ variant: "success", title: language.t("agentConfig.clonedTitle", { name: plan.name }) })
      // 🔴 A folder change ARCHIVES this colleague's chat and opens a successor in the new folder
      // (`agent/reassignment.ts`) — deliberately, because a cross-project move is refused outright.
      // The tab has to follow, or the user keeps talking to a conversation that has been filed.
      //
      // Measured on the owner's instance 2026-09-03: it did not follow, and the filed chat took 296
      // more events over three minutes. Work landed in the colleague's scratch and a write to the
      // real project was refused as `external_directory_write` — correctly, because that session's
      // root really was scratch. The correctly-rooted successor sat unopened at 2 events.
      //
      // ⚠️ Best-effort and AFTER the save: a session list that will not load must not fail a config
      // write that already succeeded. The tab is then stale, which is where this started, but the
      // write is not lost on top of it.
      try {
        // `sdk()` is optional here, unlike the two call sites that guard it earlier in the file.
        const client = sdk()
        const rows = client === undefined ? [] : await listSessions(client)
        tabs.followAgentChats(
          rows.map((row) => ({
            id: row.id,
            ...(row.agent === undefined ? {} : { agent: row.agent }),
            ...(row.parentID === undefined ? {} : { parentID: row.parentID }),
            archived: row.time.archived !== undefined,
          })),
        )
      } catch {
        // Deliberately swallowed — see above.
      }
      props.onChanged?.()
      props.onDismiss()
    } catch (error) {
      showToast(
        isNovaCloneRefusal(error)
          ? {
              title: language.t("agentConfig.cloneNovaTitle"),
              description: language.t("agentConfig.cloneNovaDescription"),
            }
          : { variant: "error", title: language.t("agentConfig.cloneFailed"), description: String(error) },
      )
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * Clear this colleague's chat: the conversation is removed and the NEXT one starts empty. The
   * colleague, its brief and its memory all survive — this is a new session, not a retirement.
   *
   * 🔴 **It used to announce a clearing the user could still see had not happened** (owner,
   * 2026-08-27: *"it say chat cleared, but all the messages are still in chat window"*). The archive
   * itself worked; what was missing is that this dialog is opened FROM the composer as well as from
   * the roster, so the common path is Tune → Clear inside the very chat being cleared. The dialog
   * closed, the toast said *"Chat cleared"*, and the transcript underneath was untouched — the route
   * still names that session, so the view keeps rendering it. Ruling 2 cuts here: a fault is never
   * described falsely, and neither is a success. The cleared conversation must LEAVE the screen, or
   * the sentence is a lie about the thing the user is looking at.
   *
   * ⚠️ Navigating only when the route actually names the cleared session, rather than always: from
   * Contacts the user is not in that chat, and yanking them home from a roster they were working
   * through would be its own small betrayal.
   *
   * 🔴 **CONFIRMED.** Not because bytes are destroyed — the row survives with a `time_archived` — but
   * because no surface a user has can bring the conversation back, which is the test `retire` already
   * applies one control over. `setPaused` deliberately does NOT confirm, and that asymmetry is the
   * point: confirming reversible acts is what teaches people to click through the ones that matter.
   */
  const clearChat = async () => {
    const id = props.agentID
    const client = sdk()
    if (id === undefined || client === undefined) return
    if (
      !(await confirm({
        title: language.t("agentConfig.clear.confirm.title", { name: name() }),
        description: language.t("agentConfig.clear.confirm.description", { name: name() }),
        confirmLabel: language.t("agentConfig.clear.confirm.action"),
        destructive: true,
      }))
    )
      return
    setBusy("clear")
    try {
      const sessions = await listSessions(client)
      /**
       * 🔴 **Not `chatFor`.** It answers "which chat is this colleague's now" and excludes archived
       * rows, which is right for the roster and wrong here: the owner's `umbris` had four root chats,
       * every one of them archived, and the newest was the transcript in the open tab. Clear reported
       * *"There is no chat to clear yet"* about a conversation on screen. See `chatToClear`.
       *
       * 🔴 And not `chatToClear` ALONE either (owner, 2026-09-16). Clearing one chat while another
       * live root exists does not give the user a fresh chat — `createSessionRecord` is idempotent on
       * the canonical `ses_<agent>` id, so the "successor" is that other conversation, handed back
       * with its transcript, tokens and cost still on screen. `rootsToClear` takes every live root of
       * the colleague, which is what "Clear chat" promises and what the one-chat-per-colleague rule
       * makes safe.
       */
      const targets = rootsToClear(sessions, id, location.pathname)
      if (targets.length === 0) {
        showToast({ variant: "default", title: language.t("agentConfig.clearNothing") })
        return
      }
      /**
       * 🔴 **Clearing DELETES the chat; it used to archive it** (2026-08-28). Two reasons, and they
       * are the same reason:
       *
       * · An archived chat is still in the chats picker, dimmed — so a conversation the user cleared,
       *   behind a destructive confirmation, was one click away from being read again. That is the
       *   same complaint as the tab that kept rendering it, one surface further out.
       * · A colleague's chat now carries the colleague's ID (`createSessionRecord`). An archived row
       *   holding that id would push the replacement onto a generated one, so the very act of asking
       *   for a fresh chat would cost the colleague the id that says the chat is theirs.
       *
       * `session.remove` is not a bare row delete: it takes the children, the session-scoped
       * memories and the Strict artifacts with it. That is what "Clear chat" promises.
       */
      for (const target of targets) {
        const removed = await client.session.remove({ sessionID: target.id })
        if (removed.error) throw removed.error
      }
      // WHICH of the cleared chats the open tab was seated on — there can now be more than one, and
      // the tab is seated on at most one of them (`AGENTS.md`: one chat per colleague, one tab per
      // colleague). `undefined` means the user was looking at something else entirely.
      const seated = targets.find((target) => location.pathname.includes(target.id))?.id
      const viewingCleared = seated !== undefined
      showToast({ variant: "success", title: language.t("agentConfig.clearedTitle") })
      props.onChanged?.()
      props.onDismiss()
      /**
       * ⚠️ **The tab KEEPS ITS SEAT and opens the fresh chat** (owner, 2026-09-03: *"it for some
       * reason closed the existing chat tab, instead of replacing it with a blank one"*).
       *
       * The 2026-08-28 ruling this replaces was right about the defect it fixed — a cleared
       * conversation must not stay one click away in the strip — and wrong about the remedy. Closing
       * the tab treats the chat as the thing the tab is FOR, but under the ECS lens the colleague is
       * the entity and the chat is a component reached through it: clearing replaces the component,
       * it does not retire the colleague. Taking the tab away makes the user re-open a colleague they
       * never dismissed, and on the last tab it drops them at Home.
       *
       * `addSessionTab` already holds the one-tab-per-colleague invariant and RE-POINTS that tab at
       * the id it is given, in place, so the seat and its position survive — the same mechanism a
       * reassignment's successor already travels through.
       *
       * ⚠️ Order is forced: remove, THEN create. A colleague may hold only one live root chat
       * (`session_agent_live_root_idx`), so creating first would either collide or hand back the very
       * chat being cleared.
       */
      const key = serverKey()
      const successor = await startChat(client, { agentID: id, title: name() })
      if (key === undefined) {
        if (viewingCleared) navigate("/")
      } else if (successor === undefined) {
        // No successor to sit in the seat. Closing beats stranding the tab on a deleted chat, which
        // is the dead end this whole path exists to avoid. With nothing seated there is nothing to
        // strand, so the close is skipped rather than aimed at an id from another screen.
        if (seated !== undefined) tabs.closeSessionTab(key, seated)
      } else {
        const tab = tabs.addSessionTab({ server: key, sessionId: successor, agent: id })
        if (viewingCleared) navigate(tabHref(tab))
      }
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.clearFailed"), description: String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  /** Clear the colleague's private filing cabinet, without touching its identity, brief or chat. */
  const clearMemory = async () => {
    const id = props.agentID
    const current = conn()
    if (id === undefined || current === undefined) return
    if (
      !(await confirm({
        title: language.t("agentConfig.memoryClear.confirm.title", { name: name() }),
        description: language.t("agentConfig.memoryClear.confirm.description", { name: name() }),
        confirmLabel: language.t("agentConfig.memoryClear.confirm.action"),
        destructive: true,
      }))
    )
      return
    setBusy("clear-memory")
    try {
      await worldMemoryClearScopeVerified(current.http, {
        directory: sync().data.path?.directory ?? "",
        scope: `agent:${id}`,
      })
      showToast({ variant: "success", title: language.t("agentConfig.memoryClear.done", { name: name() }) })
      props.onChanged?.()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("agentConfig.memoryClear.failed", { name: name() }),
        description: String(error),
      })
    } finally {
      setBusy(undefined)
    }
  }

  /** Retire the colleague. Refused by the API for the governing agent, which is why the control is
   *  not rendered for it — the roster must not offer what the endpoint will decline.
   *
   *  🔴 CONFIRMED even though nothing is destroyed. Retiring archives the chat and SETS ASIDE the
   *  private memories (`core/agent/retire.ts` — the id returns to the name pool, so nothing may be
   *  left keyed on it), which is recoverable in principle and not through any surface a user has.
   *  A control that removes a colleague from the roster and empties its cabinet, one click deep and
   *  in the same row as Clone, still deserves the sentence that says so. */
  /**
   * PAUSE / RESUME — set the colleague aside without retiring it.
   *
   * ⚠️ **Deliberately NOT confirm-gated, and that asymmetry is the point.** Retirement asks first
   * because it archives the chats and moves the cabinet to `retired:<id>:<at>`; pausing changes one
   * boolean and is undone by pressing the same button again. Confirming a reversible act teaches
   * people to click through confirmations, which is how the irreversible one stops being read.
   */
  const setPaused = async (paused: boolean) => {
    const id = props.agentID
    // ⚠️ No `governing()` clause: pausing the CEO is allowed (owner ruling 2026-09-15 — the three
    // exceptions are the project folder, cloning and retirement, and `AgentV2`'s own note has always
    // said the user "may still pause or ignore Nova"). It is one reversible boolean, and
    // `permission.ts` already answers a paused agent with deny-`*`-on-`*`.
    if (id === undefined) return
    setBusy("pause")
    try {
      await sync().updateConfig({ agents: { [id]: { disabled: paused } } } as never)
      props.onChanged?.()
    } catch (error) {
      // Said, never swallowed: a colleague that silently refuses to pause reads as a dead control.
      showToast({ variant: "error", title: language.t("agentConfig.pauseFailed"), description: String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const retire = async () => {
    const id = props.agentID
    const client = sdk()
    if (id === undefined || client === undefined || governing()) return
    if (
      !(await confirm({
        title: language.t("agentConfig.retire.confirm.title", { name: name() }),
        description: language.t("agentConfig.retire.confirm.description"),
        confirmLabel: language.t("agentConfig.retire.confirm.action"),
        destructive: true,
      }))
    )
      return
    setBusy("retire")
    try {
      await (client as never as { agent: { remove: (input: unknown) => Promise<{ error?: unknown }> } }).agent
        .remove({ agentID: id })
        .then((response) => {
          if (response.error) throw response.error
        })
      showToast({ variant: "success", title: language.t("agentConfig.retiredTitle", { name: name() }) })
      // Retiring ARCHIVES the colleague's chat, so it leaves exactly the same orphaned tab clearing
      // did — a conversation belonging to somebody no longer on the roster.
      const retiredChat = chatFor(await listSessions(client), id)
      const retiredKey = serverKey()
      if (retiredChat && retiredKey) tabs.closeSessionTab(retiredKey, retiredChat.id)
      props.onChanged?.()
      props.onDismiss()
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.retireFailed"), description: String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const save = async () => {
    const id = props.agentID
    if (id === undefined) return
    setSaving(true)
    try {
      // The ordinary config merge — one agent's fragment, layered like any other config write.
      // The id is NOT in this patch and never will be: it keys `agent:<id>`, so renaming it would
      // orphan the colleague from everything it remembers. A rename moves the NAME only.
      // ⚠️ Every key here is CONDITIONAL, and that is review D3. These five used to be sent
      // unconditionally from a `*Value()` accessor whose fallback chain is draft → stored → empty —
      // so while the dialog's own roster fetch was still in flight, `agent()` was `undefined` and
      // `title`/`personality` resolved to `""`. One character typed into Name before the fetch
      // landed, then Save, wrote away the brief the user spent ten minutes on, and the toast said it
      // worked. The guard on the button (`agent() === undefined`) closes the window; sending only
      // what was loaded or touched closes the class.
      const requirement = classifyRequirement(needsTaxonomyValue())
      const binding: Pick<ConfigV2Agent, "model" | "needsTaxonomy"> & {
        reasoningModel?: string
        workerModel?: string
        reasoningBudget?: number
        maxToolTimeoutMs?: number
        workerPrototype?: string
        maxWorkers?: number
        spawnDepth?: number
        runtimeHeartbeatMinutes?: number
        contextBudget?: boolean
        surgicalEdits?: boolean
        introspection?: boolean
        quality?: boolean
        affective?: boolean
      } = {
        ...(modelValue() === "" ? {} : { model: modelValue() }),
        ...(reasoningModelValue() === "" ? {} : { reasoningModel: reasoningModelValue() }),
        ...(workerModelValue() === "" ? {} : { workerModel: workerModelValue() }),
        ...(needsTaxonomy() === undefined || requirement === undefined ? {} : { needsTaxonomy: requirement }),
        ...(reasoningBudget() === undefined || parsedReasoningBudget() === undefined
          ? {}
          : { reasoningBudget: parsedReasoningBudget() }),
        ...(maxToolTimeoutMinutes() === undefined || parsedMaxToolTimeoutMs() === undefined
          ? {}
          : { maxToolTimeoutMs: parsedMaxToolTimeoutMs() }),
        ...(workerPrototypeValue() === "" ? {} : { workerPrototype: workerPrototypeValue() }),
        ...(maxWorkers() === undefined ? {} : { maxWorkers: parsedMaxWorkers() }),
        ...(spawnDepth() === undefined ? {} : { spawnDepth: parsedSpawnDepth() }),
        ...(runtimeHeartbeatMinutes() === undefined
          ? {}
          : { runtimeHeartbeatMinutes: parsedRuntimeHeartbeatMinutes() }),
        ...(contextBudget() === undefined ? {} : { contextBudget: contextBudget()! }),
        ...(surgicalEdits() === undefined ? {} : { surgicalEdits: surgicalEdits()! }),
        ...(introspection() === undefined ? {} : { introspection: introspection()! }),
        ...(quality() === undefined ? {} : { quality: quality()! }),
        ...(affective() === undefined ? {} : { affective: affective()! }),
      }
      // 🔴 ONE payload for every colleague, including the governing agent (owner ruling 2026-09-15).
      // Nova used to get a TWO-KEY fragment because the server refused anything outside
      // `AgentV2.PROTECTED_TUNABLE` for it; that refusal is now about WHO is writing, and this is the
      // operator's own surface, so Nova is saved exactly as any other officer is.
      //
      // ⚠️ The ONE field that stays out is the project folder: `directory` is refused for the
      // governing agent at the store, so sending it — including the `""` that means "clear it" — would
      // turn a legitimate save into an all-or-nothing refusal and lose the rest of the user's edits
      // with it. The picker is not rendered for Nova either, so the two statements agree.
      await sync().updateConfig({
        agents: {
          [id]: {
            ...(renamed() === undefined && agent()?.name === undefined ? {} : { name: nameValue() }),
            ...(title() === undefined && agent()?.title === undefined ? {} : { title: titleValue() }),
            ...(personality() === undefined && agent()?.personality === undefined
              ? {}
              : { personality: personalityValue() }),
            ...(job() === undefined && agent()?.system === undefined ? {} : { system: jobValue() }),
            memory: memoryValue(),
            // Sent as `""` when cleared, which the config decoder stores as "no folder" — the field is
            // optional, so an empty string is how a UI says "unset" through a merge patch.
            // A pure Chat role has no project component. Clear an old assignment even when this
            // save changed another field, so a stale hidden folder cannot spring back later.
            ...(governing()
              ? {}
              : postureValue()
                ? { directory: "" }
                : directory() === undefined
                  ? {}
                  : { directory: directory()!.trim() }),
            ...(posture() === undefined ? {} : { shortChat: posture()! }),
            ...(permissionMode() === undefined ? {} : { permissionMode: permissionMode()! }),
            ...(strict() === undefined ? {} : { strict: { enabled: strict()! } }),
            ...(operationMode() === undefined ? {} : { operationMode: operationMode()! }),
            ...(goal() === undefined ? {} : { goal: goalValue() }),
            ...(toolLabels() === undefined ? {} : { toolLabels: toolLabels()! }),
            ...(instructions() === undefined ? {} : { instructions: instructions()! }),
            // A ruleset patch REPLACES the array, so the officer's and the user's other rules ride
            // along in `computerRuleset()`. An empty result is not sent as `[]` — see the deletion.
            ...(computerUse() === undefined || computerRuleset().length === 0
              ? {}
              : { permissions: computerRuleset() }),
            archiveChats: archiveValue(),
            // The governing agent reports to nobody (`AgentV2.resolveSuperior` answers undefined for
            // it), so the selector is not rendered and the key is not sent: a field the system would
            // discard is not written either.
            ...(governing() || superior() === undefined || superior() === "" ? {} : { superior: superior()! }),
            ...binding,
          },
        },
      } as never)
      // Materialise the standing operation choice onto the colleague's own root chat immediately. A
      // NEW root reads it during construction in the kernel; an EXISTING one keeps the type it was
      // stamped with, so without this the switch changes what the NEXT chat would be and nothing the
      // user can see.
      //
      // 🔴 **That silent half is the reported bug** (owner, 2026-09-15: *"it actually affects the
      // agent's goal mode — as of now `* Goal` is still shown after agent's name in the chat's prompt
      // area even in Interactive mode"*). Two things made it silent, and both are fixed here:
      //   · the target came from `chatFor`, which EXCLUDES archived rows — so a colleague whose chat
      //     had been filed (a documented, reachable state — see `roster-live.ts`) resolved to
      //     `undefined` and the switch was skipped without a word. `chatToClear` is the helper that
      //     answers "which transcript does the user mean", archived or not, and it is what Clear
      //     already uses for exactly this reason;
      //   · every guard was an `&&`, so "no connection", "no chat" and "no folder" all took the same
      //     silent path. The config write above has already committed by then, so the answer is not to
      //     fail the save — it is to SAY what did not happen, which is the rule a success sentence
      //     obeys.
      if (operationMode() !== undefined) {
        const target = conn()
        const chat = chatToClear(sessionRows() ?? [], id, location.pathname)
        const folder = directoryValue() ?? workspacePath()
        if (target && chat && folder)
          await switchType(target.http, {
            directory: folder,
            sessionID: chat.id,
            type: operationMode() === "interactive" ? "interactive" : "goal-oriented",
          })
        else
          showToast({
            variant: "error",
            title: language.t("agentConfig.modeNotApplied"),
            description: language.t("agentConfig.modeNotAppliedWhy"),
          })
      }
      // Config patches preserve omitted fields and reject null. Returning to inheritance is a
      // deletion, and only an explicitly changed selector may request it.
      await sync().removeConfig([
        ...(model() === "" ? [["agents", id, "model"]] : []),
        ...(reasoningModel() === "" ? [["agents", id, "reasoningModel"]] : []),
        ...(workerModel() === "" ? [["agents", id, "workerModel"]] : []),
        ...(needsTaxonomy() === NO_REQUIREMENT ? [["agents", id, "needsTaxonomy"]] : []),
        ...(reasoningBudget() === "" ? [["agents", id, "reasoningBudget"]] : []),
        ...(maxToolTimeoutMinutes() === "" ? [["agents", id, "maxToolTimeoutMs"]] : []),
        ...(superior() === "" ? [["agents", id, "superior"]] : []),
        ...(workerPrototype() === "" ? [["agents", id, "workerPrototype"]] : []),
        // Switched back ON and nothing else was ever refused: the field goes away entirely, so the
        // officer inherits the floor's grant the same as a colleague that was never configured.
        ...(computerUse() !== undefined && computerRuleset().length === 0 ? [["agents", id, "permissions"]] : []),
      ])
      const current = conn()
      if (current === undefined) throw new Error("No instance is connected")
      if (avatarFile() !== undefined) await uploadAgentAvatar(current.http, id, avatarFile()!)
      else if (avatarRemoved()) await removeAgentAvatar(current.http, id)
      setRenamed(undefined)
      setTitle(undefined)
      setPersonality(undefined)
      setJob(undefined)
      setAvatarFile(undefined)
      setAvatarRemoved(false)
      setMemory(undefined)
      setDirectory(undefined)
      setPosture(undefined)
      setPermissionMode(undefined)
      setStrict(undefined)
      setOperationMode(undefined)
      setGoal(undefined)
      setContextBudget(undefined)
      setSurgicalEdits(undefined)
      setIntrospection(undefined)
      setQuality(undefined)
      setAffective(undefined)
      setComputerUse(undefined)
      setToolLabels(undefined)
      setArchive(undefined)
      setModel(undefined)
      setReasoningModel(undefined)
      setWorkerModel(undefined)
      setReasoningBudget(undefined)
      setMaxToolTimeoutMinutes(undefined)
      setWorkerPrototype(undefined)
      setMaxWorkers(undefined)
      setSpawnDepth(undefined)
      setRuntimeHeartbeatMinutes(undefined)
      setSuperior(undefined)
      setNeedsTaxonomy(undefined)
      props.onChanged?.()
      props.onDismiss()
    } catch (error) {
      // A failed save is SAID, never swallowed: the fields still hold the user's words, and telling
      // them it worked when it did not is how a person loses a brief they spent ten minutes writing.
      showToast({ variant: "error", title: language.t("agentConfig.saveFailed"), description: String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base">
      <div class="flex min-w-0 items-center gap-3 border-b border-v2-border-border-base px-3 py-3 sm:px-4">
        {/* BACK, not just an X. This panel is opened from a list you were reading a moment ago —
              the roster, or the chat you were tuning — so the gesture out of it is "return", and
              labelling it that way is the difference between a dead end and a step. */}
        <button
          type="button"
          data-action="agent-config-back"
          class="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
          aria-label={language.t("agentConfig.back")}
          title={language.t("agentConfig.back")}
          onClick={props.onDismiss}
        >
          <Icon name="chevron-left" size="normal" />
        </button>
        <AgentPortrait
          id={props.agentID ?? ""}
          name={name()}
          avatar={agent()?.avatar}
          class="size-9 border border-v2-border-border-strong text-base"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold">{name()}</span>
          <span class="block truncate text-xs text-v2-text-text-muted">
            {agent()?.title ?? language.t("agentConfig.noTitle")}
          </span>
        </span>
        <span class="hidden sm:block">
          <ControlScope kind="colleague" />
        </span>
        {/* HELP, beside Close: the one door to everything this screen used to explain inline. It sits
              in the header rather than by a control because it explains the MODEL, not this field. */}
        <button
          type="button"
          class="shrink-0 rounded-md p-1.5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base"
          aria-label={language.t("agentHelp.title")}
          title={language.t("agentHelp.title")}
          onClick={() => openHelp()}
        >
          <Icon name="help" class="size-4" />
        </button>
        <button type="button" class="text-xs text-v2-text-text-muted hover:underline" onClick={props.onDismiss}>
          {language.t("agentConfig.close")}
        </button>
      </div>

      <div class="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden md:flex-row">
        <nav
          class="flex shrink-0 gap-1 overflow-x-auto border-b border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 py-2 md:w-52 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-4"
          aria-label="Officer settings"
        >
          <For each={settingsTabs()}>
            {(tab) => (
              <button
                type="button"
                class={`flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors ${
                  activeTab() === tab.id
                    ? "bg-v2-background-bg-layer-03 font-medium text-v2-text-text-base shadow-sm"
                    : "text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                }`}
                aria-current={activeTab() === tab.id ? "page" : undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon name={tab.icon} class="hidden size-4 shrink-0 sm:block" />
                <span>{tab.label}</span>
              </button>
            )}
          </For>
        </nav>
        <div
          class="agent-settings-panels min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 md:px-8 md:py-7"
          data-active-tab={activeTab()}
        >
          <div class="mx-auto w-full max-w-3xl">
            <section class="agent-settings-card" data-section="profile" data-settings-tab="profile">
              {/* 🔴 NOVA'S PROFILE IS THE USER'S TO SHAPE, exactly like any other colleague's (owner
                  ruling 2026-09-15). The tree root is not a locked record — the whole editable form is
                  mounted for it. What IS fixed is named here rather than discovered by pressing a
                  control that refuses: the governing agent cannot be given a project folder, retired
                  or cloned. */}
              <Show when={governing()}>
                <p
                  data-section="governing-note"
                  class="mt-2 rounded-md bg-v2-background-bg-layer-02 px-3 py-2 text-[11px] leading-relaxed text-v2-text-text-faint"
                >
                  {language.t("agentConfig.governingNote")}
                </p>
              </Show>
              <label class="block text-xs text-v2-text-text-muted">
                {language.t("agentConfig.name")}
                <TextInputV2
                  class="mt-1"
                  value={nameValue()}
                  onInput={(event) => setRenamed(event.currentTarget.value)}
                />
              </label>
              {/* Why a rename is safe, said once where someone is about to do it. */}
              <label class="mt-3 block text-xs text-v2-text-text-muted">
                {language.t("agentConfig.jobTitle")}
                <TextInputV2
                  class="mt-1"
                  value={titleValue()}
                  onInput={(event) => setTitle(event.currentTarget.value)}
                  placeholder={language.t("agentConfig.jobTitlePlaceholder")}
                />
              </label>
              <label class="mt-3 block text-xs text-v2-text-text-muted">
                {language.t("agentConfig.personality")}
                <textarea
                  class="mt-1 min-h-20 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                  value={personalityValue()}
                  onInput={(event) => setPersonality(event.currentTarget.value)}
                  placeholder={language.t("agentConfig.personalityPlaceholder")}
                />
              </label>
              <label class="mt-3 block text-xs text-v2-text-text-muted">
                Job instructions
                <textarea
                  aria-label="Job instructions"
                  class="mt-1 min-h-24 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                  value={jobValue()}
                  onInput={(event) => setJob(event.currentTarget.value)}
                  placeholder="What this officer is responsible for, and what a good result looks like."
                />
              </label>
              <div class="mt-4 flex flex-col gap-2 border-t border-v2-border-border-muted pt-4 sm:flex-row">
                <input
                  ref={(element) => (personalityInput = element)}
                  type="file"
                  accept="application/json,.json"
                  class="hidden"
                  onChange={(event) => {
                    void importPersonality(event.currentTarget.files?.[0])
                    event.currentTarget.value = ""
                  }}
                />
                <button
                  type="button"
                  data-action="agent-personality-import"
                  class="w-full rounded-md bg-v2-background-bg-layer-03 px-3 py-2 text-xs font-medium hover:bg-v2-background-bg-layer-02 sm:w-auto"
                  onClick={() => personalityInput?.click()}
                >
                  Import personality
                </button>
                <button
                  type="button"
                  data-action="agent-personality-export"
                  class="w-full rounded-md px-3 py-2 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 sm:w-auto"
                  onClick={exportPersonality}
                >
                  Export personality
                </button>
              </div>
              <p class="mt-2 text-[11px] leading-relaxed text-v2-text-text-faint">
                Portable JSON contains the name, job title, personality, and job instructions only. Models, folders,
                authority, memories, and chat history stay with this instance.
              </p>
              {/* Why this is a profile field and not something you type into the chat. */}
              <div class="mt-3 text-xs text-v2-text-text-muted">
                {language.t("agentConfig.portrait")}
                <span class="mt-1 block text-[11px] text-v2-text-text-faint">
                  {language.t("agentConfig.portraitHint")}
                </span>
                <div class="mt-2 flex min-w-0 items-center gap-2">
                  <label
                    for="agent-portrait-file"
                    class="inline-flex shrink-0 cursor-pointer items-center rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs font-medium text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                  >
                    {language.t("agentConfig.portraitChoose")}
                  </label>
                  <span class="min-w-0 truncate text-xs text-v2-text-text-faint">
                    {avatarFile()?.name ?? language.t("agentConfig.portraitNone")}
                  </span>
                  <input
                    id="agent-portrait-file"
                    class="sr-only"
                    type="file"
                    accept={[...AGENT_AVATAR_TYPES].join(",")}
                    onChange={(event) => {
                      setAvatarFile(event.currentTarget.files?.[0])
                      setAvatarRemoved(false)
                    }}
                  />
                </div>
                <Show when={!avatarRemoved() && isAgentPortraitURL(agent()?.avatar)}>
                  <button
                    type="button"
                    class="mt-2 text-xs text-v2-text-text-accent hover:underline"
                    onClick={() => {
                      setAvatarFile(undefined)
                      setAvatarRemoved(true)
                    }}
                  >
                    {language.t("agentConfig.portraitRemove")}
                  </button>
                </Show>
              </div>
              {/* 🔴 THE REPORTING LINE IS PART OF WHO THIS COLLEAGUE IS, so it lives in PROFILE
                  (owner, 2026-09-16), beside the name, title and portrait — not in Mind, which is
                  where it landed when it was the first use of a picker and has been read as a
                  thinking setting ever since. The org chart is an identity structure
                  (`AGENTS.md`, the structural metaphor): the superior is who the colleague answers
                  to, which is a fact about the role, not about how it reasons.

                  ⚠️ NOVA REPORTS TO NOBODY, so the selector is not rendered for it.
                  `resolveSuperior` answers `undefined` for the governing agent by construction, which
                  makes this field inert for Nova — and the rule this dialog already states is that a
                  field the system would discard is not rendered as editable. */}
              <Show when={!governing()}>
                <div class="mt-4 border-t border-v2-border-border-muted pt-4">
                  <label class="block text-xs text-v2-text-text-muted" for="agent-superior">
                    {language.t("agentConfig.superior")}
                  </label>
                  <SelectV2
                    id="agent-superior"
                    aria-label={language.t("agentConfig.superior")}
                    class="mt-1 w-full"
                    options={superiorOptions()}
                    current={
                      superiorOptions().find((option) =>
                        superiorValue() === GOVERNING_ID ? option.value === "" : option.value === superiorValue(),
                      ) ?? superiorOptions()[0]
                    }
                    value={(option) => option.key}
                    label={(option) => option.label}
                    onSelect={(option) => option && setSuperior(option.value)}
                  />
                  <p class="mt-1 text-[11px] text-v2-text-text-faint">
                    {language.t("agentConfig.superiorDescription")}
                  </p>
                </div>
              </Show>
            </section>

            <section class="agent-settings-card" data-section="memory" data-settings-tab="memory">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                {language.t("agentConfig.memory")}
              </h3>
              <div class="mt-2 flex flex-col gap-1.5">
                {/* ONE switch, not a pair of radios: "persistent memory" and "throwaway" are the same
                  switch seen from two sides, and the radios made the negative half read like a
                  feature to shop for. The line under it says WHICH SIDE IS IN FORCE right now, in
                  both halves — this is the surface where someone decides what a colleague keeps, so
                  it is the last place that should describe only the private half. */}
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={memoryValue() === "own"}
                    onChange={(event) => setMemory(event.currentTarget.checked ? "own" : "none")}
                  />
                  <span>{language.t("agentConfig.memoryRag")}</span>
                </label>
                <p class="text-[11px] text-v2-text-text-faint">
                  {language.t(memoryDisclosure(memoryValue()).privateKey)}
                  <Show when={memoryValue() === "own"}> {language.t(memoryDisclosure("own").sharedKey)}</Show>
                </p>
                {/* The filing cabinet and its destructive action belong beside the switch that
                    governs it. On a phone these stack into two full-width, easy targets; from `sm`
                    upward they collapse into one quiet action row. */}
                <div class="mt-4 flex flex-col gap-2 border-t border-v2-border-border-muted pt-4 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    data-action="agent-open-memory"
                    class="w-full rounded-md bg-v2-background-bg-layer-03 px-3 py-2 text-xs font-medium text-v2-text-text-accent hover:bg-v2-background-bg-layer-02 disabled:opacity-40 sm:w-auto"
                    disabled={busy() !== undefined || props.agentID === undefined}
                    onClick={() => {
                      const id = props.agentID
                      if (id === undefined) return
                      props.onDismiss()
                      navigate(ownerRoute(id))
                    }}
                  >
                    {language.t("agentConfig.memoryOpen")}
                  </button>
                  <button
                    type="button"
                    data-action="agent-clear-memory"
                    class="w-full rounded-md px-3 py-2 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40 sm:w-auto"
                    disabled={busy() !== undefined || props.agentID === undefined}
                    onClick={() => void clearMemory()}
                  >
                    {busy() === "clear-memory"
                      ? language.t("agentConfig.memoryClearing")
                      : language.t("agentConfig.clearMemory")}
                  </button>
                </div>
              </div>
            </section>

            <section class="agent-settings-card" data-section="model" data-settings-tab="mind">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                {language.t("agentConfig.mind")}
              </h3>
              {/* 🔴 The Interactive<->Unattended switch and the durable Goal now live in the WORK tab
                  (owner, 2026-09-15). They are standing choices about how this officer OPERATES, the
                  same family as posture, permission mode and Strict — and the Mind tab is about how it
                  thinks (its model). Splitting one decision across two tabs is how a user loses it. */}
              {/* 🔴 The model belongs to the COLLEAGUE, not to the chat. A chat-scoped model made the
                same colleague clever in one conversation and poor in the next, for reasons the user
                could not see. A colleague has one mind. */}
              <SelectV2
                aria-label={language.t("agentConfig.mind")}
                class="mt-2 w-full"
                options={modelOptions()}
                current={modelOptions().find((option) => option.value === modelValue()) ?? modelOptions()[0]}
                value={(option) => option.key}
                label={(option) => option.label}
                onSelect={(option) => option && setModel(option.value)}
              />
              <Show when={modelBlocked()}>
                {(blocked) => (
                  <p class="mt-1 text-[11px] leading-relaxed text-v2-state-fg-warning">
                    {language.t(
                      blocked().kind === "switched-off"
                        ? "agentConfig.modelSwitchedOffHelp"
                        : "agentConfig.modelUnavailableHelp",
                      { model: blocked().value },
                    )}
                  </p>
                )}
              </Show>
              <label class="mt-4 block text-xs font-medium text-v2-text-text-muted">Reasoning model</label>
              <SelectV2
                aria-label="Reasoning model"
                class="mt-1 w-full"
                options={reasoningModelOptions()}
                current={
                  reasoningModelOptions().find((option) => option.value === reasoningModelValue()) ??
                  reasoningModelOptions()[0]
                }
                value={(option) => option.key}
                label={(option) => option.label}
                onSelect={(option) => option && setReasoningModel(option.value)}
              />
              <p class="mt-1 text-[11px] leading-relaxed text-v2-text-text-faint">
                Nova opens a private thinking phase on this model, then gives the checked result to the ordinary model
                for tool calls and the answer. Choose “Use the ordinary model” to keep both phases on one model.
              </p>
              <label class="mt-3 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={toolLabelsValue()}
                  onChange={(event) => setToolLabels(event.currentTarget.checked)}
                />
                <span>{language.t("agentConfig.toolLabels")}</span>
              </label>
              <p class="text-[11px] text-v2-text-text-faint">
                {language.t(toolLabelsValue() ? "agentConfig.toolLabels.on" : "agentConfig.toolLabels.off")}
              </p>
              <label class="mt-3 block text-xs text-v2-text-text-muted" for="agent-reasoning-budget">
                {language.t("agentConfig.reasoningBudget")}
              </label>
              <input
                id="agent-reasoning-budget"
                aria-label={language.t("agentConfig.reasoningBudget")}
                class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                type="number"
                min="0"
                step="1"
                value={reasoningBudgetValue()}
                placeholder={language.t("agentConfig.reasoningBudgetModel")}
                onInput={(event) => setReasoningBudget(event.currentTarget.value)}
              />
              <p class="mt-1 text-[11px] text-v2-text-text-faint">
                {reasoningBudgetValue().trim() === ""
                  ? language.t("agentConfig.reasoningBudgetDefault")
                  : parsedReasoningBudget() === 0
                    ? language.t("agentConfig.reasoningBudgetOff")
                    : language.t("agentConfig.reasoningBudgetCustom", { tokens: reasoningBudgetValue() })}
              </p>
              {/* 🔴 The class this ROLE needs, which is a different statement from the model bound
                above. A colleague can end up on the instance default without anyone choosing it —
                its own model may be unavailable or have been failing — and a demanding role on a
                model of the wrong class does not error, it just gets things wrong. The requirement
                is what lets the colleague notice and SAY so. */}
              <label class="mt-3 block text-xs text-v2-text-text-muted" for="agent-needs-taxonomy">
                {language.t("agentConfig.needsTaxonomy")}
              </label>
              <SelectV2
                id="agent-needs-taxonomy"
                aria-label={language.t("agentConfig.needsTaxonomy")}
                class="mt-1 w-full"
                options={requirementOptions}
                current={needsTaxonomyValue()}
                value={(option) => option}
                label={(option) =>
                  option === NO_REQUIREMENT
                    ? language.t("agentConfig.needsTaxonomyNone")
                    : taxonomyLabel(language.t, option)
                }
                onSelect={(option) => setNeedsTaxonomy(option ?? NO_REQUIREMENT)}
              />
              <p class="mt-1 text-[11px] text-v2-text-text-faint">{language.t("agentConfig.needsTaxonomyHelp")}</p>
              <Show when={belowFloor()}>
                <p class="mt-1 text-[11px] text-v2-state-fg-warning">{language.t("agentConfig.needsTaxonomyBelow")}</p>
              </Show>
              {/* 🔴 MOOD SAMPLING SITS LAST (owner, 2026-09-16). It is the one control here that
                  changes the WEIGHTS' behaviour rather than choosing which weights run, so it reads as
                  an aside after the model decisions above it — and at the top it pushed the model
                  picker, which is what this tab is for, below the fold. */}
              <label class="mt-4 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={affectiveValue()}
                  onChange={(event) => setAffective(event.currentTarget.checked)}
                />
                <span>
                  <span class="block">Mood sampling</span>
                  <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                    Adapts the model’s sampling to its appraised mood — steadier when frustrated, freer when exploring.
                  </span>
                </span>
              </label>
            </section>

            <section class="agent-settings-card" data-section="work" data-settings-tab="work">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                {language.t("agentConfig.work")}
              </h3>
              <div class="mt-2">
                <button
                  type="button"
                  class="rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs text-v2-text-text-base disabled:opacity-40"
                  disabled={officerSessionID() === undefined || sdk() === undefined}
                  onClick={() => void exportOfficerPrompt()}
                >
                  {language.t("context.export.prompt")}
                </button>
                <p class="mt-1 text-[11px] text-v2-text-text-faint">{language.t("agentConfig.exportPrompt.hint")}</p>
              </div>
              {/* 🔴 The three standing WORK choices, moved off the composer 2026-08-21 (owner: the
                Chat/Agent drop-down, Strict and permissions "should be part of the agent too"). They
                describe the ROLE: a bookkeeper that needs Analyze mode needs it every time you talk to
                it, and re-choosing per chat is a question asked again for a decision that never
                changes. A chat can still differ — these are a LAYER, and the chat's own row wins. */}
              <div class="mt-2 flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span>{language.t("agentConfig.posture")}</span>
                  <SelectV2
                    appearance="inline"
                    aria-label={language.t("agentConfig.posture")}
                    options={POSTURE_CHOICES}
                    current={postureValue() ? "chat" : "agent"}
                    label={(value) =>
                      language.t(value === "chat" ? "prompt.posture.chat.title" : "prompt.posture.agent.title")
                    }
                    onSelect={(value) => {
                      if (!value) return
                      setPosture(value === "chat")
                      if (value === "chat") setDirectory("")
                    }}
                  />
                </div>
                <p class="text-[11px] text-v2-text-text-faint">
                  {language.t(postureValue() ? "prompt.posture.chat.description" : "prompt.posture.agent.description")}
                </p>

                <div class="flex items-center justify-between gap-2 text-xs">
                  <span>{language.t("prompt.permissionMode.title")}</span>
                  <SelectV2
                    appearance="inline"
                    aria-label={language.t("prompt.permissionMode.title")}
                    options={PERMISSION_MODE_CHOICES}
                    current={
                      PERMISSION_MODE_CHOICES.find((mode) => mode === permissionModeValue()) ??
                      PERMISSION_MODE_CHOICES[1]
                    }
                    label={(mode) => language.t(`prompt.permissionMode.${mode}`)}
                    onSelect={(mode) => mode && setPermissionMode(mode)}
                  />
                </div>

                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={strictValue()}
                    onChange={(event) => setStrict(event.currentTarget.checked)}
                  />
                  <span>{language.t("agentConfig.strict")}</span>
                </label>

                {/* 🔴 MAXIMUM TOOL WAIT BELONGS HERE (owner, 2026-09-16), immediately under Strict,
                    because the two answer the same question from its two ends: Strict says a step that
                    fails is retried and verified, and this says how long ONE step may hold the floor
                    before it is cut off and control comes back. In Mind it sat under the model
                    pickers, where it read as a property of the weights rather than a rule about this
                    officer's work. */}
                <label class="mt-3 block text-xs text-v2-text-text-muted" for="agent-tool-timeout">
                  {language.t("agentConfig.maxToolTimeout")}
                </label>
                <input
                  id="agent-tool-timeout"
                  aria-label={language.t("agentConfig.maxToolTimeout")}
                  class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                  type="number"
                  min="1"
                  step="1"
                  value={maxToolTimeoutMinutesValue()}
                  placeholder={language.t("agentConfig.maxToolTimeoutDefault")}
                  onInput={(event) => setMaxToolTimeoutMinutes(event.currentTarget.value)}
                />
                <p class="mt-1 text-[11px] text-v2-text-text-faint">
                  {maxToolTimeoutMinutesValue().trim() === ""
                    ? language.t("agentConfig.maxToolTimeoutHelpDefault")
                    : language.t("agentConfig.maxToolTimeoutHelpCustom", {
                        minutes: maxToolTimeoutMinutesValue(),
                      })}
                </p>

                {/* 🔴 ONE SWITCH, NOT TWO CARDS (owner ruling 2026-09-15: *"switching from
                    Interactive<->Unattended is a toggle switch (default Interactive), instead of being
                    two buttons"*), and it lives in the WORK tab (owner, 2026-09-15).

                    It is a standing choice about how this officer OPERATES — the same family as
                    posture, permission mode and Strict above — while Mind is about how it thinks. The
                    pair read as two features to shop for when they are one decision seen from two
                    sides, so the switch names the mode that is NOT the default and the line beneath
                    says WHICH ONE IS IN FORCE right now, in both positions, because a switch with one
                    labelled end tells you nothing when it is off. */}
                <div class="mt-3 rounded-xl border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3">
                  <div class="flex items-start justify-between gap-3">
                    <span class="block text-sm font-medium">{language.t("agentConfig.unattended")}</span>
                    <SwitchToggle
                      aria-label={language.t("agentConfig.unattended")}
                      checked={operationModeValue() === "unattended"}
                      onChange={(checked) => setOperationMode(checked ? "unattended" : "interactive")}
                    />
                  </div>
                  <p class="mt-1 text-[11px] leading-relaxed text-v2-text-text-faint">
                    {language.t(
                      operationModeValue() === "unattended"
                        ? "agentConfig.unattended.on"
                        : "agentConfig.unattended.off",
                    )}
                  </p>
                </div>
                <label class="mt-4 block text-xs text-v2-text-text-muted">
                  Goal
                  <textarea
                    aria-label="Goal"
                    class="mt-1 min-h-24 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-2 text-sm"
                    value={goalValue()}
                    onInput={(event) => setGoal(event.currentTarget.value)}
                    placeholder="What should this officer keep working toward?"
                  />
                </label>
                {/* ⚠️ The paragraph that used to sit in Mind repeated the Unattended sentence verbatim —
                    "keeps prompting toward this durable goal… sleeps for 10 minutes" — one control above
                    the switch that now says it. What is left is the part the switch cannot say: the goal
                    is DURABLE, and it survives compaction, which is why it is worth typing. */}
                <p class="mt-1 text-[11px] leading-relaxed text-v2-text-text-faint">
                  The goal survives compaction, so this officer keeps it even after a long chat is trimmed.
                </p>

                <label class="block text-xs text-v2-text-text-muted">
                  Live work heartbeat
                  <span class="mt-1 flex items-center gap-2">
                    <input
                      aria-label="Live work heartbeat in minutes"
                      class="w-24 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-2 text-sm text-v2-text-text-base"
                      type="number"
                      min="1"
                      step="1"
                      value={runtimeHeartbeatMinutesValue()}
                      onInput={(event) => setRuntimeHeartbeatMinutes(event.currentTarget.value)}
                    />
                    <span>minutes</span>
                  </span>
                  <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                    While this officer owns live workers or background shells, remind it what is still running. Changes
                    are reported immediately. Default 60 minutes.
                  </span>
                </label>

                <div class="my-2 border-t border-v2-border-border-muted" />
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={contextBudgetValue()}
                    onChange={(event) => setContextBudget(event.currentTarget.checked)}
                  />
                  <span>
                    <span class="block">Context guard</span>
                    <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                      Keep conversation, recalled memory, knowledge retrieval, and tool output from crowding one another
                      out.
                    </span>
                  </span>
                </label>
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={surgicalEditsValue()}
                    onChange={(event) => setSurgicalEdits(event.currentTarget.checked)}
                  />
                  <span>
                    <span class="block">Edits instead of overwriting</span>
                    <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                      Reject overwriting files and nudge the agent toward small, targeted edits.
                    </span>
                  </span>
                </label>
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={introspectionValue()}
                    onChange={(event) => setIntrospection(event.currentTarget.checked)}
                  />
                  <span>
                    <span class="block">Stuck detector</span>
                    <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                      A judge model periodically checks whether the agent is stuck and nudges it to change approach.
                    </span>
                  </span>
                </label>
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={qualityValue()}
                    onChange={(event) => setQuality(event.currentTarget.checked)}
                  />
                  <span>
                    <span class="block">Quality gates</span>
                    <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                      Compile and test after code edits, then steer the agent to fix failures before finishing.
                    </span>
                  </span>
                </label>

                {/* Officers are granted Computer Use by the floor, so the switch is an OPT-OUT and this
                  row only exists where that grant actually reaches. A subagent has no grant to opt out
                  of, and showing it a switch reading "on" would be a control that lies. */}
                <Show when={agent() !== undefined && isColleague(agent()!)}>
                  <label class="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      class="mt-0.5"
                      checked={computerUseValue()}
                      onChange={(event) => setComputerUse(event.currentTarget.checked)}
                    />
                    <span>{language.t("agentConfig.computerUse")}</span>
                  </label>
                  <p class="text-[11px] text-v2-text-text-faint">
                    {language.t(computerUseValue() ? "agentConfig.computerUse.on" : "agentConfig.computerUse.off")}
                  </p>
                </Show>
              </div>
            </section>

            <Show when={props.agentID}>
              {(id) => (
                <section class="agent-settings-card" data-settings-tab="nudges" data-section="nudges">
                  <SettingsNudgesV2 fixedAgentID={id()} />
                </section>
              )}
            </Show>

            <Show when={!postureValue()}>
              <section class="agent-settings-card" data-settings-tab="work">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                  {language.t("agentConfig.folder")}
                </h3>
                {/* 🔴 The colleague's PROJECT, and it lives here rather than in the prompt area (owner,
                2026-08-21). Asking which folder a chat runs in made "where does this work happen" a
                per-conversation question and left a named officer with no project of its own; under the
                roster it is part of the job — you assign the bookkeeper to the books once. */}
                <div class="mt-2 flex items-center gap-2">
                  {/* 🔴 NOVA HAS NO PROJECT FOLDER, by construction (`AgentV2.PROTECTED_NEVER`), and the
                      owner named it as one of exactly three things the user cannot do to the governing
                      agent. Said plainly rather than shown as a disabled picker: a greyed control
                      invites the user to wonder what would unlock it, and the answer is "nothing". */}
                  <Show
                    when={!governing()}
                    fallback={
                      <span class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-v2-background-bg-layer-02 px-2 py-1.5 text-xs text-v2-text-text-faint">
                        <Icon name="folder" class="size-3.5 shrink-0" />
                        <span class="truncate">{language.t("agentConfig.folderGoverning")}</span>
                      </span>
                    }
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-v2-background-bg-layer-03 px-2 py-1.5 text-left text-xs disabled:opacity-40"
                      onClick={() => pickFolder()}
                    >
                      <Icon name="folder" class="size-3.5 shrink-0" />
                      <span class="truncate">{folderLabel()}</span>
                    </button>
                    <Show when={directoryValue() !== undefined}>
                      {/* Back to its own workspace — the one way out of a project, and it is a change like any
                      other: the colleague is told (`AgentReassignment`). */}
                      <button
                        type="button"
                        class="shrink-0 rounded-md px-2 py-1.5 text-xs text-v2-text-text-faint hover:bg-v2-background-bg-layer-03"
                        onClick={() => setDirectory("")}
                      >
                        {language.t("agentConfig.folderOwn")}
                      </button>
                    </Show>
                  </Show>
                </div>
                {/* 🔴 BOTH FOLDERS, and this is the half the user could not see (owner, 2026-08-22: *"please
                ensure user can browse the agent's Scratch folder"*). A colleague keeps its own workspace
                even when assigned to a project — `AgentPlugin.scratchDirsFor` grants it and
                `SystemCompose.workspaceSection` tells the colleague about it — so the notes, drafts and
                probe scripts it writes there were real files nobody had a way to open.

                ⚠️ Rendered whether or not a project is assigned, because the workspace exists either
                way: when there is no project it IS the working folder, and when there is one it is the
                place the colleague keeps everything that is not the project's. Hiding it in the second
                case would hide exactly the files the user has no other route to. */}
                <Show when={workspacePath()}>
                  {(path) => (
                    /**
                     * 🔴 **It CLOSES this dialog on the way out, deliberately** (owner, 2026-08-28: the
                     * browse link "also closes the Tune for some reason").
                     *
                     * It was never a modal — it is a link to `/files`, and Files is a ROUTE. So the
                     * navigation unmounted Tune as a side effect and the dialog appeared to vanish on the
                     * way back. The vision settles which half to fix: Files is THE file surface, an app in
                     * the shell (principle 7 — "prefer an app in the shell over a developer surface"), so
                     * a second file browser living inside this dialog would be the wrong answer to a
                     * question the launcher already answers.
                     *
                     * What was wrong is that leaving happened SILENTLY. Dismissing first makes it a step
                     * the user takes — Tune, then Files — instead of a dialog that evaporates behind
                     * them, which is the same rule the Back button in this header exists for: the gesture
                     * out of a panel is "return", and an unannounced one is a dead end wearing a link.
                     */
                    <a
                      data-action="browse-workspace"
                      href={`/files?path=${encodeURIComponent(path())}`}
                      onClick={() => props.onDismiss()}
                      class="mt-2 inline-flex items-center gap-1.5 text-[11px] text-v2-text-text-faint underline hover:text-v2-text-text-base"
                    >
                      <Icon name="folder" class="size-3 shrink-0" />
                      {language.t("agentConfig.browseWorkspace", { name: name() })}
                    </a>
                  )}
                </Show>
                {/* The working folder's AGENTS.md is opt-in (owner, 2026-09-17). It belongs here beside the
                    folder because it is a fact about that folder, and the row states the default in words
                    rather than leaving a bare unchecked box the user has to interpret. */}
                <label class="mt-4 flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={instructionsValue()}
                    onChange={(event) => setInstructions(event.currentTarget.checked)}
                  />
                  <span>{language.t("agentConfig.instructions")}</span>
                </label>
                <p class="mt-1 text-[11px] leading-relaxed text-v2-text-text-faint">
                  {language.t(instructionsValue() ? "agentConfig.instructions.on" : "agentConfig.instructions.off")}
                </p>
              </section>
            </Show>

            <section class="agent-settings-card" data-settings-tab="memory">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                {language.t("agentConfig.archive")}
              </h3>
              <div class="mt-2 flex flex-col gap-1.5">
                {/* A chat that never ends gets compacted; this decides whether the compressed-away half
                  stays searchable or is gone but for a summary. */}
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={archiveValue()}
                    disabled={memoryValue() === "none"}
                    onChange={(event) => setArchive(event.currentTarget.checked)}
                  />
                  <span>{language.t("agentConfig.archiveKeep")}</span>
                </label>
                <Show when={memoryValue() === "none"}>
                  {/* Said rather than silently ignored: a throwaway keeps nothing, so the control above
                    would be a promise this colleague cannot make. */}
                  <p class="text-[11px] text-v2-text-text-faint">{language.t("agentConfig.archiveThrowaway")}</p>
                </Show>
              </div>
            </section>

            <section class="agent-settings-card" data-settings-tab="workers" data-section="workers">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">Worker fleet</h3>
              <p class="mt-2 text-xs leading-relaxed text-v2-text-text-faint">
                These limits cover every unfinished worker below this officer, including workers spawned by workers.
              </p>
              <label class="mt-4 block text-xs text-v2-text-text-muted">Worker prototype</label>
              <SelectV2
                aria-label="Worker prototype"
                class="mt-1 w-full"
                options={workerPrototypeOptions()}
                current={
                  workerPrototypeOptions().find((option) => option.value === workerPrototypeValue()) ??
                  workerPrototypeOptions()[0]
                }
                value={(option) => option.key}
                label={(option) => option.label}
                onSelect={(option) => option && setWorkerPrototype(option.value)}
              />
              <p class="mt-1 text-[11px] leading-relaxed text-v2-text-text-faint">
                A worker copies this officer’s role and model settings, but remains an anonymous temporary session. If
                no prototype is selected, it inherits this officer’s recipe. Either way it shares this officer’s memory
                and authority, and reports to the session that spawned it—not to the prototype’s superior.
              </p>
              <label class="mt-4 block text-xs text-v2-text-text-muted">Worker model</label>
              <SelectV2
                aria-label="Worker model"
                class="mt-1 w-full"
                options={workerModelOptions()}
                current={
                  workerModelOptions().find((option) => option.value === workerModelValue()) ?? workerModelOptions()[0]
                }
                value={(option) => option.key}
                label={(option) => option.label}
                onSelect={(option) => option && setWorkerModel(option.value)}
              />
              <p class="mt-1 text-[11px] leading-relaxed text-v2-text-text-faint">
                Used for workers when no prototype is selected. Inherit uses this officer’s ordinary model.
              </p>
              <div class="mt-5 grid gap-4 sm:grid-cols-2">
                <label class="block text-xs text-v2-text-text-muted">
                  Maximum active workers
                  <input
                    aria-label="Maximum active workers"
                    class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-2 text-sm"
                    type="number"
                    min="0"
                    step="1"
                    value={maxWorkersValue()}
                    onInput={(event) => setMaxWorkers(event.currentTarget.value)}
                  />
                  <span class="mt-1 block text-[11px] text-v2-text-text-faint">
                    Across the entire worker tree. Default 100.
                  </span>
                </label>
                <label class="block text-xs text-v2-text-text-muted">
                  Spawn depth
                  <input
                    aria-label="Spawn depth"
                    class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-2 text-sm"
                    type="number"
                    min="0"
                    step="1"
                    value={spawnDepthValue()}
                    onInput={(event) => setSpawnDepth(event.currentTarget.value)}
                  />
                  <span class="mt-1 block text-[11px] text-v2-text-text-faint">
                    0 disables workers; 1 allows only this officer to spawn. Default 1.
                  </span>
                </label>
              </div>
              <div class="mt-5 rounded-xl border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3 text-xs text-v2-text-text-muted">
                Worker command captions are always off, keeping presentation-only model calls out of batch work.
              </div>
            </section>

            <section class="agent-settings-card" data-settings-tab="io" data-section="input-output">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">Input / Output</h3>
              <p class="mt-2 text-xs leading-relaxed text-v2-text-text-faint">
                Let a messenger conversation feed this officer’s prompt and carry its replies. The selected account
                determines the messenger tool and identity; trust controls what remote participants may ask it to do.
              </p>
              <div class="mt-4 rounded-xl border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3 sm:p-4">
                <AgentRemoteChat sessionID={officerSessionID} ensureSession={ensureOfficerSession} />
              </div>
            </section>

            <Show when={props.tuning}>
              {(tuning) => (
                <section class="agent-settings-card" data-settings-tab="chat">
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                    {language.t("agentConfig.thisChat")}
                  </h3>
                  {/* The distinction the two sections exist to teach: above is who this colleague IS
                    everywhere, below is how this one conversation runs. */}
                  <div class="mt-2">{tuning()()}</div>
                </section>
              )}
            </Show>
          </div>
        </div>
      </div>

      {/* Lifecycle, kept apart from the profile fields: these do something the moment they are
            pressed, while everything above waits for Save. */}
      <div class="flex min-w-0 flex-wrap items-center gap-1 border-t border-v2-border-border-muted px-2 py-2 sm:gap-2 sm:px-4 sm:py-2.5">
        <button
          type="button"
          data-action="agent-clear-chat"
          class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
          disabled={busy() !== undefined || props.agentID === undefined}
          onClick={() => void clearChat()}
        >
          {busy() === "clear" ? language.t("agentConfig.clearing") : language.t("agentConfig.clearChat")}
        </button>
        {/* 🔴 CLONE IS NOT OFFERED FOR THE GOVERNING AGENT (owner ruling 2026-09-15: the user cannot
              clone Nova). `planClone` has always refused it server-side, and the button used to stay
              visible on purpose so pressing it taught *why* a second Nova is a second instance. That
              teaching now lives in the note at the top of Nova's Profile tab, and a control whose only
              outcome is a refusal is worse than the sentence that replaces it. */}
        <Show when={!governing()}>
          <button
            type="button"
            class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
            disabled={busy() !== undefined || agent() === undefined}
            onClick={() => void clone()}
          >
            {busy() === "clone" ? language.t("agentConfig.cloning") : language.t("agentConfig.clone")}
          </button>
        </Show>
        {/* ⚠️ Ordinary weight, NOT danger red, and separated from Retire — the two must not read
              as the same kind of act. Pausing is reversible and keeps everything; retiring
              archives the chats and sets the cabinet aside.
              ⚠️ Pause IS offered for the governing agent: the owner's exceptions are exactly three —
              no project folder, no clone, no retire — and `AgentV2`'s own note has always said the
              user "may still pause or ignore Nova". */}
        <button
          type="button"
          data-action="agent-pause"
          class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
          disabled={busy() !== undefined || agent() === undefined}
          onClick={() => void setPaused(agent()?.paused !== true)}
        >
          {busy() === "pause"
            ? language.t("agentConfig.pausing")
            : agent()?.paused === true
              ? language.t("agentConfig.resume")
              : language.t("agentConfig.pause")}
        </button>
        {/* 🔴 RETIRE IS THE THIRD THING THE USER CANNOT DO TO THE TREE ROOT. `DELETE /api/agent/:id`
              answers 400 for it, so this is the control being told the truth rather than a hole in
              the UI. */}
        <Show when={!governing()}>
          <button
            type="button"
            class="ml-auto rounded-md px-2.5 py-1.5 text-xs text-v2-state-fg-danger hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
            disabled={busy() !== undefined || props.agentID === undefined}
            onClick={() => void retire()}
          >
            {busy() === "retire" ? language.t("agentConfig.retiring") : language.t("agentConfig.retire")}
          </button>
        </Show>
      </div>
      {/* The Save/Cancel row is unconditional now: the governing agent's profile is edited on this
            surface like any other officer's, so it needs the same door out and the same commit. */}
      <div class="flex items-center justify-end gap-2 border-t border-v2-border-border-base px-4 py-2.5">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
          onClick={props.onDismiss}
        >
          {language.t("agentConfig.cancel")}
        </button>
        <button
          type="button"
          class="rounded-md bg-v2-background-bg-layer-03 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          // ⚠️ `agent() === undefined` is the same clause the Clone button beside this one carries,
          // and Save was the one that lacked it (review D3). `dirty()` needs ONE touched field, so
          // without it a save fired before the roster landed wrote the fields it had not read yet.
          disabled={
            !dirty() ||
            !reasoningBudgetValid() ||
            !maxToolTimeoutValid() ||
            Number.isNaN(parsedMaxWorkers()) ||
            Number.isNaN(parsedSpawnDepth()) ||
            Number.isNaN(parsedRuntimeHeartbeatMinutes()) ||
            saving() ||
            props.agentID === undefined ||
            agent() === undefined
          }
          onClick={() => void save()}
        >
          {saving() ? language.t("agentConfig.saving") : language.t("agentConfig.save")}
        </button>
      </div>
    </div>
  )
}

/** Transitional source-compatible name; the component itself is now an addressable app screen. */
export const AgentConfigDialog = AgentConfigScreen
