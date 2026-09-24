import type { ConfigV2Agent } from "@novaclaw/sdk/v2/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs as KobalteTabs } from "@kobalte/core/tabs"
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
import { chatFor, chatToClear } from "@/apps/roster-live"
import { GOVERNING_ID, displayName, isColleague, memoryKey, superiorCandidates, type AgentLike } from "@/apps/contacts"
import { ownerRoute } from "@/apps/memory-owner"
import { worldMemoryClearScopeVerified } from "@/utils/memory-api"
import { useLocation, useNavigate } from "@solidjs/router"
import { AgentPortrait } from "@/components/agent-portrait"
import { AGENT_AVATAR_TYPES, removeAgentAvatar, uploadAgentAvatar } from "@/apps/agent-avatar"
import { isAgentPortraitURL } from "@/apps/agent-portrait"
import { AgentHelpDialog } from "@/components/agent-help-dialog"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useTabs } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { SettingsNudgesV2 } from "@/components/settings-v2/nudges"
import { SettingsScheduleV2 } from "@/components/settings-v2/schedule"
import { PresetFieldV2 } from "@/components/settings-v2/parts/preset-field"
import { OfficerRecipes } from "@/components/officer-recipes"
import { OfficerContext } from "@/components/settings-v2/officer-context"
import { OfficerQuality } from "@/components/settings-v2/officer-quality"
import { OfficerMessengers } from "@/components/settings-v2/officer-messengers"
import { CORE_TOOLS, PERMISSION_MODE_CHOICES, officerCapabilities, withComputerUse, withToolOverride } from "@/apps/officer-capabilities"
import type { Recipe as AdhocRecipe } from "@/components/settings-v2/tools-draft"
import { planSettingsCopy } from "@/apps/agent-settings-copy"
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

// The three roster kinds (owner, 2026-09-17): a full officer, a pure Chat, and the instance's
// owning user. Human is a first-class entity, not an absence.
const MODE_CHOICES = ["interactive", "agent", "chat", "human"] as const
type OfficerMode = (typeof MODE_CHOICES)[number]

/**
 * Merge touched struct-subfield drafts over the stored struct, for the per-officer
 * Strict/Affective/Introspection tabs.
 *
 * `undefined` draft = untouched (the stored value, if any, rides along untouched);
 * `""` = back to inherit (the key leaves the struct, even when stored); anything else
 * replaces. A non-finite number is refused rather than written — the Save button already
 * guards every numeric draft, so reaching one here is a caller bug, not user input.
 */
const mergeDraft = (stored: Record<string, unknown>, touched: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...stored }
  for (const [key, value] of Object.entries(touched)) {
    if (value === undefined) continue
    if (value === "") delete next[key]
    else if (typeof value === "number" && !Number.isFinite(value)) continue
    else next[key] = value
  }
  return next
}
/** A drafted number for `mergeDraft`: untouched, back-to-inherit, or the parsed value. */
const numTouched = (raw: string | undefined): number | "" | undefined => {
  if (raw === undefined) return undefined
  if (raw.trim() === "") return ""
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}
/** Drafted text for `mergeDraft`: untouched, back-to-inherit on empty, or the trimmed text. */
const textTouched = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  return raw.trim() === "" ? "" : raw.trim()
}

/**
 * Tool names the horizon editor SUGGESTS. Mirrors the Nudges tab's list: the built-ins plus
 * whatever ad-hoc recipes this instance carries. There is no tool-inventory endpoint, so a
 * free-text add stays beside the suggestions and SAYS it is the fallback (principle 12b) —
 * the day a catalog endpoint exists, this list becomes discovery.
 */

// ⚠️ **A field the system would discard is not rendered as editable.** What makes a field
// discardable is the RULE, not the colleague: an agent's own `configure` tool may not rewrite the
// governing agent's charter, so that arm is closed where writes happen. The operator's surface is a
// different actor, and Nova is edited here exactly as any other officer is — with exactly three
// things absent, because the store refuses them: no project folder, no clone, no retirement
// (owner ruling 2026-09-15). Offering an input whose value goes nowhere is worse than offering
// nothing: the user does the work, sees no error, and learns not to trust the surface.

export function OfficerSettingsScreen(props: {
  agentID: string
  onDismiss: () => void
  /**
   * Something about the roster CHANGED — a hire, a retirement, a cleared chat, a saved profile.
   *
   * ⚠️ The screen cannot refetch the list it was opened from, and without this it does not try:
   * measured 2026-08-21, retiring a colleague removed it from the server and left its row on screen
   * until a manual reload. The durable change with the stale view, one more time.
   */
  onChanged?: () => void
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
  // 🔴 The server context's ONE shared roster — this screen used to fetch `GET /api/agent` again on
  // EVERY open (review D8), and that in-flight window is what made D3 possible: `agent()` was
  // `undefined` for a moment on a page that had the data on screen a second earlier, so a Save fired
  // in that window wrote the colleague's brief away as `""`. It also carries the `.catch` this call
  // site was missing (D1) — a rejected resource read from the eager memo below reached the app's one
  // ErrorBoundary, at its root, and replaced the whole UI.
  const agents = () => ctx()?.agents.list()
  const agent = createMemo<AgentLike | undefined>(() => (agents() ?? []).find((row) => row.id === props.agentID))
  const capabilities = createMemo(() => officerCapabilities(agent()?.config as Record<string, unknown> | undefined))

  const governing = createMemo(() => props.agentID === GOVERNING_ID)

  const name = createMemo(() => agent()?.name?.trim() || displayName(props.agentID))

  // Drafts start empty and fall back to the stored value at render, so an edit survives a re-read of
  // the roster while an untouched field keeps tracking the server.
  const [renamed, setRenamed] = createSignal<string | undefined>()
  const [title, setTitle] = createSignal<string | undefined>()
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
  const [posture, setPosture] = createSignal<"agent" | "chat" | "human" | undefined>()
  const [permissionMode, setPermissionMode] = createSignal<string | undefined>()
  const [strict, setStrict] = createSignal<boolean | undefined>()
  const [operationMode, setOperationMode] = createSignal<"interactive" | "unattended" | undefined>()
  const [goal, setGoal] = createSignal<string | undefined>()
  const [surgicalEdits, setSurgicalEdits] = createSignal<boolean | undefined>()
  const [introspection, setIntrospection] = createSignal<boolean | undefined>()
  const [affective, setAffective] = createSignal<boolean | undefined>()
  /**
   * Strict/Affective/Introspection DETAIL drafts, one signal per subfield.
   *
   * `undefined` = untouched (the stored struct, if any, is sent back merged); `""` on a
   * text/number draft = back to inherit for that subfield (the key leaves the struct on
   * save). Booleans have no "" state — an untouched lever inherits, a touched one is explicit.
   */
  const [strictVerification, setStrictVerification] = createSignal<boolean | undefined>()
  const [strictRecovery, setStrictRecovery] = createSignal<boolean | undefined>()
  const [strictEditingAids, setStrictEditingAids] = createSignal<boolean | undefined>()
  const [strictBudgetSteering, setStrictBudgetSteering] = createSignal<boolean | undefined>()
  const [strictAttempts, setStrictAttempts] = createSignal<string | undefined>()
  const [strictWallMinutes, setStrictWallMinutes] = createSignal<string | undefined>()
  const [strictExecutionTokens, setStrictExecutionTokens] = createSignal<string | undefined>()
  const [strictReasoningTokens, setStrictReasoningTokens] = createSignal<string | undefined>()
  const [affTemperature, setAffTemperature] = createSignal<string | undefined>()
  const [affExtended, setAffExtended] = createSignal<boolean | undefined>()
  const [intrCadence, setIntrCadence] = createSignal<string | undefined>()
  const [intrModel, setIntrModel] = createSignal<string | undefined>()
  const [intrPrompt, setIntrPrompt] = createSignal<string | undefined>()
  const [intrInterjection, setIntrInterjection] = createSignal<string | undefined>()
  const [intrGenerate, setIntrGenerate] = createSignal<boolean | undefined>()
  /**
   * Tools-tab drafts. Recipes and the horizon save LIVE (like Nudges), not through the Save
   * button: they are replace-semantics lists, and merging them with the scalar drafts would
   * need a second save path for the same struct. The editor below is a draft; everything
   * else here writes through immediately and says so where it does.
   */
  const [horizonAdd, setHorizonAdd] = createSignal("")
  /** Copy-tuning source officer. `undefined` = none picked. Blocked while scalar drafts are
   *  dirty — a live copy underneath unsaved edits would silently lose to them on Save. */
  const [copySource, setCopySource] = createSignal<string | undefined>()
  /**
   * Tool-call captions, drafted as the OPT-OUT. `undefined` = untouched; ON is the default, so a
   * stored `false` is the only way this colleague stops paying a model call per shell command for a
   * caption that never reaches the model.
   */
  const [toolLabels, setToolLabels] = createSignal<boolean | undefined>()
  /**
   * Computer Use, drafted as the OPT-OUT rather than as the permission. `undefined` = untouched;
   * `true` = hand the officer back to the floor's grant (the rule goes away); `false` = store the deny.
   * Absence means ON, so there is exactly one place that says whether an officer can touch the
   * desktop — the floor in `core/src/plugin/agent.ts` — and a stored rule exists only to refuse.
   */
  const [computerUse, setComputerUse] = createSignal<boolean | undefined>()
  const models = useModels()
  const [saving, setSaving] = createSignal(false)
  type SettingsTab =
    | "work"
    | "capabilities"
    | "profile"
    | "mind"
    | "context"
    | "quality"
    | "nudges"
    | "schedule"
    | "memory"
    | "messengers"
  const [activeTab, setActiveTab] = createSignal<SettingsTab>(
    new URLSearchParams(location.search).get("tab") === "messengers" ? "messengers" : "work",
  )
  const desktopSettings = createMediaQuery("(min-width: 768px)")
  const settingsTabs = () => [
    { id: "work" as const, label: "Work", icon: "task" as const },
    { id: "capabilities" as const, label: "Capabilities", icon: "shield" as const },
    { id: "profile" as const, label: "Profile", icon: "user" as const },
    { id: "mind" as const, label: "Mind", icon: "brain" as const },
    { id: "context" as const, label: "Context", icon: "archive" as const },
    { id: "quality" as const, label: "Quality", icon: "checklist" as const },
    { id: "memory" as const, label: "Memory", icon: "archive" as const },
    { id: "messengers" as const, label: "Messengers", icon: "chats" as const },
    { id: "nudges" as const, label: "Nudges", icon: "prompt" as const },
    ...(postureValue() === "agent" ? [{ id: "schedule" as const, label: "Schedule", icon: "calendar" as const }] : []),
  ]
  /**
   * ⚠️ Through the dialog STACK, not as a nested `<Dialog>`. The first attempt rendered
   * `<AgentHelpDialog>` inside this component's tree and nothing appeared: the shell's content is a
   * Kobalte `Dialog.Content`, which needs the root the stack provides, so a second one mounted inline
   * has no context to attach to. `showScoped` also binds its life to this component, so leaving the screen
   * cannot leave Help orphaned above an empty screen.
   */
  const openHelp = () => void dialogStack.showScoped(() => <AgentHelpDialog onDismiss={() => dialogStack.close()} />)

  const nameValue = () => renamed() ?? agent()?.name ?? displayName(props.agentID)
  const titleValue = () => title() ?? agent()?.title ?? ""
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
  const memoryValue = () => memory() ?? agent()?.memory ?? (postureValue() === "agent" ? "own" : "none")
  const directoryValue = () => {
    const draft = directory()
    if (draft !== undefined) return draft.trim() === "" ? undefined : draft
    const stored = (agent()?.config?.["directory"] as string | undefined)?.trim()
    return stored ? stored : undefined
  }
  // Each reads the DRAFT first, then the colleague's stored value, then the shipped baseline — the
  // same "absent means inherit" the config layer itself uses, so the screen shows what a chat with
  // this colleague would actually start with.
  const postureValue = (): "agent" | "chat" | "human" => {
    const draft = posture()
    if (draft !== undefined) return draft
    const stored = agent()?.config?.["kind"]
    if (stored === "agent" || stored === "chat" || stored === "human") return stored
    return agent()?.config?.["shortChat"] === true ? "chat" : "agent"
  }
  const permissionModeValue = () => permissionMode() ?? capabilities().permissionMode
  // ⚠️ DEFAULT INTERACTIVE (owner ruling 2026-09-15). This read `=== "interactive" ? "interactive" :
  // "unattended"`, i.e. anything not explicitly interactive — including "never set" — displayed as
  // Unattended. So a colleague nobody had configured showed a switch in the ON position for a mode
  // it was not actually in, and the person reading it had no way to tell "chosen" from "unset".
  const operationModeValue = () =>
    operationMode() ??
    ((agent()?.config?.["operationMode"] as string | undefined) === "unattended" ? "unattended" : "interactive")
  const modeValue = (): OfficerMode =>
    postureValue() === "agent" ? (operationModeValue() === "unattended" ? "agent" : "interactive") : postureValue()
  const selectMode = (mode: OfficerMode) => {
    setPosture(mode === "interactive" ? "agent" : mode)
    setOperationMode(mode === "agent" ? "unattended" : "interactive")
    if (mode === "chat" || mode === "human") setDirectory("")
  }
  const goalValue = () => goal() ?? (agent()?.config?.["goal"] as string | undefined) ?? ""
  const standingValue = (draft: boolean | undefined, key: string, fallback: boolean) =>
    draft ?? (agent()?.config?.[key] as boolean | undefined) ?? fallback
  const surgicalEditsValue = () => standingValue(surgicalEdits(), "surgicalEdits", false)
  // Stored harness detail, normalized: the schema carries bool-or-struct for these two (old
  // rows are bare booleans, new writes are structs) and a struct for Strict. Absent = inherit.
  type LooseStruct = Record<string, string | number | boolean | undefined>
  const strictStored = () => (agent()?.config?.["strict"] ?? {}) as LooseStruct
  const affStored = (): LooseStruct => {
    const raw = agent()?.config?.["affective"]
    return typeof raw === "boolean" ? { enabled: raw } : ((raw ?? {}) as LooseStruct)
  }
  const intrStored = (): LooseStruct => {
    const raw = agent()?.config?.["introspection"]
    return typeof raw === "boolean" ? { enabled: raw } : ((raw ?? {}) as LooseStruct)
  }
  const structNumber = (value: string | number | boolean | undefined): string =>
    typeof value === "number" ? String(value) : ""
  const structText = (value: string | number | boolean | undefined): string => (typeof value === "string" ? value : "")
  // The ENABLED stance for each tab: draft, then the stored struct's (or bare boolean's)
  // `enabled`, then the shipped default. Lever groups below default ON — they are engine
  // defaults the switches override, exactly as the global Strict tab reads them.
  const strictValue = () => strict() ?? (strictStored().enabled as boolean | undefined) ?? false
  const introspectionValue = () => introspection() ?? (intrStored().enabled as boolean | undefined) ?? false
  const affectiveValue = () => affective() ?? (affStored().enabled as boolean | undefined) ?? false
  const strictLever = (draft: boolean | undefined, key: string) =>
    draft ?? (strictStored()[key] as boolean | undefined) ?? true
  const strictVerificationValue = () => strictLever(strictVerification(), "verification")
  const strictRecoveryValue = () => strictLever(strictRecovery(), "recovery")
  const strictEditingAidsValue = () => strictLever(strictEditingAids(), "editingAids")
  const strictBudgetSteeringValue = () => strictLever(strictBudgetSteering(), "budgetSteering")
  const strictAttemptsValue = () => strictAttempts() ?? structNumber(strictStored().attempts)
  const strictWallMinutesValue = () => strictWallMinutes() ?? structNumber(strictStored().wallMinutes)
  const strictExecutionTokensValue = () => strictExecutionTokens() ?? structNumber(strictStored().executionTokens)
  const strictReasoningTokensValue = () => strictReasoningTokens() ?? structNumber(strictStored().reasoningTokens)
  const affTemperatureValue = () => affTemperature() ?? structNumber(affStored().temperature)
  const affExtendedValue = () => affExtended() ?? (affStored().extended as boolean | undefined) ?? false
  const intrCadenceValue = () => intrCadence() ?? structNumber(intrStored().cadence)
  const intrModelValue = () => {
    const draft = intrModel()
    if (draft !== undefined) return draft
    const stored = intrStored().model
    return typeof stored === "string" ? stored : ""
  }
  const intrPromptValue = () => intrPrompt() ?? structText(intrStored().prompt)
  const intrInterjectionValue = () => intrInterjection() ?? structText(intrStored().interjection)
  const intrGenerateValue = () => intrGenerate() ?? (intrStored().generateInterjection as boolean | undefined) ?? false
  /** A drafted number, or `""` for back-to-inherit: empty is valid, unparseable is not. */
  const parseDraftNumber = (raw: string | undefined): number | "" | undefined => {
    if (raw === undefined) return undefined
    if (raw.trim() === "") return ""
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  const inRangeInt = (value: number | "" | undefined, min: number, max: number) =>
    value === undefined || value === "" || (Number.isSafeInteger(value) && value >= min && value <= max)
  const strictAttemptsValid = () => inRangeInt(parseDraftNumber(strictAttemptsValue()), 1, 8)
  const strictWallMinutesValid = () => {
    const parsed = parseDraftNumber(strictWallMinutesValue())
    return parsed === undefined || parsed === "" || (Number.isFinite(parsed) && parsed >= 1 && parsed <= 480)
  }
  const strictTokenValid = (raw: string) => {
    const parsed = parseDraftNumber(raw)
    return parsed === undefined || parsed === "" || (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 131_072)
  }
  const strictExecutionTokensValid = () => strictTokenValid(strictExecutionTokensValue())
  const strictReasoningTokensValid = () => strictTokenValid(strictReasoningTokensValue())
  const affTemperatureValid = () => {
    const parsed = parseDraftNumber(affTemperatureValue())
    return parsed === undefined || parsed === "" || (Number.isFinite(parsed) && parsed >= 0)
  }
  const intrCadenceValid = () => inRangeInt(parseDraftNumber(intrCadenceValue()), 1, 100_000)

  // ── Tools tab: horizon (live writes, like Nudges) ─────────────────────────────────
  // Recipes live in `<OfficerRecipes>`, extracted so the failed-write pin survives the
  // Settings tab's deletion (`components/officer-recipes.tsx` header).
  const officerTools = () => capabilities().tools
  /** This officer's private recipes, read from the SAME record the horizon reads — the caller
   *  owns the source and `<OfficerRecipes>` stays presentational about it. */
  const officerRecipes = () => (agent()?.config?.["adhocTools"] ?? []) as AdhocRecipe[]
  /** Suggestion buttons: the built-ins, minus what is stored. There is no tool-inventory
   *  endpoint and no instance recipe library anymore, so a free-text add stays beside the
   *  suggestions and SAYS it is the fallback (principle 12b). */
  const horizonSuggestions = createMemo(() => {
    const stored = new Set(Object.keys(officerTools()))
    return [...CORE_TOOLS].filter((name) => !stored.has(name)).sort((left, right) => left.localeCompare(right))
  })
  const writeOfficer = async (patch: Record<string, unknown>) => {
    const target = props.agentID
    try {
      await sync().updateConfig({ agents: { [target]: patch } } as never)
      props.onChanged?.()
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.saveFailed"), description: String(error) })
    }
  }
  /** Deny (`false`) or restore (`true`) one tool for this officer. Removing the row returns
   *  the tool to the routing table's decision — absent means inherit, as everywhere else. */
  const setHorizonTool = (name: string, enabled: boolean | undefined) => {
    const target = props.agentID
    const next = withToolOverride(officerTools(), name, enabled)
    // An emptied map is deleted rather than stored as `{}`: an officer that never tuned its
    // horizon and one that tuned it back to nothing must read the same, or "reset" is a lie.
    if (Object.keys(next).length === 0 && (agent()?.config?.["tools"] as unknown) !== undefined) {
      void sync()
        .removeConfig([["agents", target, "tools"]])
        .then(() => props.onChanged?.())
        .catch((error: unknown) =>
          showToast({ variant: "error", title: language.t("agentConfig.saveFailed"), description: String(error) }),
        )
      return
    }
    void writeOfficer({ tools: next })
  }

  // ── Computer Use ───────────────────────────────────────────────────────────────────────────────
  // The switch reads a PERMISSION RULE, not a field of its own, on purpose. A `computerUse: boolean`
  // on the agent would be a second answer to "may this officer touch the desktop", stored beside the
  // rule that actually decides it, and the two would drift. The rule is the truth; this is its face.
  const computerUseValue = () => computerUse() ?? capabilities().computerUse
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
    return withComputerUse(capabilities().rules, computerUse() !== false)
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
    return capabilities().workerModel ?? ""
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
    return capabilities().workerPrototype ?? ""
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
  // The judge model: inherit (the active turn's model), a runnable catalog model, or the
  // stored value when it is neither (labelled, never silently dropped — the same rule as
  // the officer's own model picker above).
  const intrModelOptions = createMemo(() =>
    withBlockedCurrent(
      [
        { key: "active", value: "", label: language.t("agentConfig.intrModelInherit") },
        ...runnableModels().map(modelChoice),
      ],
      intrModelValue(),
    ),
  )
  const integerValue = (draft: string | undefined, key: string, fallback: number) => {
    if (draft !== undefined) return draft
    const stored = agent()?.config?.[key]
    return typeof stored === "number" ? String(stored) : String(fallback)
  }
  const maxWorkersValue = () => maxWorkers() ?? String(capabilities().maxWorkers)
  const spawnDepthValue = () => spawnDepth() ?? String(capabilities().spawnDepth)
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
    ...superiorCandidates(agents() ?? [], props.agentID).map((candidate) => ({
      key: candidate.id,
      value: candidate.id,
      label: `${candidate.name?.trim() || displayName(candidate.id)} · ${candidate.title ?? language.t("agentConfig.noTitle")}`,
    })),
  ])
  /** Is the model bound above ALREADY beneath the class chosen here? Shown live, on the screen where
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
    job() !== undefined ||
    memory() !== undefined ||
    directory() !== undefined ||
    posture() !== undefined ||
    permissionMode() !== undefined ||
    strict() !== undefined ||
    operationMode() !== undefined ||
    goal() !== undefined ||
    surgicalEdits() !== undefined ||
    introspection() !== undefined ||
    affective() !== undefined ||
    strictVerification() !== undefined ||
    strictRecovery() !== undefined ||
    strictEditingAids() !== undefined ||
    strictBudgetSteering() !== undefined ||
    strictAttempts() !== undefined ||
    strictWallMinutes() !== undefined ||
    strictExecutionTokens() !== undefined ||
    strictReasoningTokens() !== undefined ||
    affTemperature() !== undefined ||
    affExtended() !== undefined ||
    intrCadence() !== undefined ||
    intrModel() !== undefined ||
    intrPrompt() !== undefined ||
    intrInterjection() !== undefined ||
    intrGenerate() !== undefined ||
    toolLabels() !== undefined ||
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

  const [busy, setBusy] = createSignal<"clone" | "clear-memory" | "retire" | "pause" | "copy" | undefined>()

  // The shared roster is also used by render/offline states that deliberately have no SDK yet.
  // Treat that as "not connected", not as a component crash during construction.
  const sdk = () => ctx()?.sdk?.client?.v2
  const [sessionRows, sessionActions] = createSettledResource(sdk, (client) => listSessions(client))
  const [createdSessionID, setCreatedSessionID] = createSignal<string | undefined>()
  const officerSessionID = () => createdSessionID() ?? chatFor(sessionRows() ?? [], props.agentID)?.id
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
      // The captured request FILE, fetched on this explicit export — never by the live prompt view.
      const response = await client.session.promptCapture({ sessionID })
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
    if (!client) return undefined
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
    downloadOfficerPersonality(`${slug}-profile.json`, {
      format: PERSONALITY_FORMAT,
      version: 1,
      profile: {
        name: nameValue(),
        title: titleValue(),
        job: jobValue(),
      },
    })
  }
  const importPersonality = async (file: File | undefined) => {
    if (!file) return
    const parsed = parseOfficerPersonality(await file.text())
    if (!parsed) {
      showToast({ variant: "error", title: "That is not a NovaClaw officer profile file" })
      return
    }
    if (parsed.profile.name !== undefined) setRenamed(parsed.profile.name)
    if (parsed.profile.title !== undefined) setTitle(parsed.profile.title)
    if (parsed.profile.job !== undefined) setJob(parsed.profile.job)
    showToast({ variant: "success", title: "Profile loaded — review it, then Save" })
  }

  /** Officers this colleague may adopt tuning from: every colleague but itself. Nova is a
   *  legitimate prototype — only tuning crosses, never the charter, so a second CEO is not created. */
  const copyCandidates = createMemo(() =>
    (agents() ?? []).filter((candidate) => candidate.id !== props.agentID && isColleague(candidate)),
  )
  /**
   * Adopt another officer's tuning onto THIS officer. Identity and work never cross (the
   * planner enforces it); private lists replace only behind a confirm, because replacing is
   * destroying. Writes live, like Clone — and like Clone it refuses to run over unsaved
   * scalar drafts, which a live write underneath would silently lose to on Save.
   */
  const copyTuning = async () => {
    const target = props.agentID
    const prototypeID = copySource()
    if (prototypeID === undefined) return
    const source = (agents() ?? []).find((row) => row.id === prototypeID)
    if (source === undefined) return
    const plan = planSettingsCopy({
      prototypeID,
      targetID: target,
      source: (source.config ?? {}) as Record<string, unknown>,
    })
    if (Object.keys(plan.fragment).length === 0) {
      showToast({ variant: "default", title: `${source.name?.trim() || prototypeID} has no tuning to copy` })
      return
    }
    if (plan.replacesLists.length > 0) {
      const names = plan.replacesLists.join(", ")
      if (
        !(await confirm({
          title: `Copy ${names} too?`,
          description: `This replaces ${name()}'s own ${names} with ${source.name?.trim() || prototypeID}'s. Everything else copies silently.`,
          confirmLabel: "Copy tuning",
          destructive: true,
        }))
      )
        return
    }
    setBusy("copy")
    try {
      await sync().updateConfig({ agents: { [target]: plan.fragment } } as never)
      showToast({ variant: "success", title: `Tuned like ${source.name?.trim() || prototypeID}` })
      props.onChanged?.()
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.saveFailed"), description: String(error) })
    } finally {
      setBusy(undefined)
    }
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

  /** Clear the colleague's private filing cabinet, without touching its identity, brief or chat. */
  const clearMemory = async () => {
    const id = props.agentID
    const current = conn()
    if (current === undefined) return
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
    if (client === undefined || governing()) return
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

  /**
   * Reset one tuning tab to inherit: delete its keys from the officer's stored config, so the
   * officer follows the shipped defaults again. Drafts for those keys are dropped with them —
   * keeping an edit for a struct just deleted would re-create it on the next save.
   *
   * ⚠️ Confirmed, because it destroys tuning. And it refuses the delete verb when nothing is
   * stored: `POST /api/config/remove` answers 400 for a path that names nothing, and a correct
   * state must never report as a failure.
   */
  const resetTab = async (tab: string, keys: string[], clear: () => void) => {
    const target = props.agentID
    const stored = (agent()?.config ?? {}) as Record<string, unknown>
    const set = keys.filter((key) => stored[key] !== undefined)
    if (set.length === 0) {
      clear()
      return
    }
    if (
      !(await confirm({
        title: language.t("agentConfig.resetTab.title", { tab }),
        description: language.t("agentConfig.resetTab.description", { tab }),
        confirmLabel: language.t("agentConfig.resetTab.action"),
        destructive: true,
      }))
    )
      return
    try {
      await sync().removeConfig(set.map((key) => ["agents", target, key]))
      clear()
      props.onChanged?.()
    } catch (error) {
      showToast({ variant: "error", title: language.t("agentConfig.resetTab.failed"), description: String(error) })
    }
  }

  const resetStrict = () =>
    void resetTab("Strict", ["strict"], () => {
      setStrict(undefined)
      setStrictVerification(undefined)
      setStrictRecovery(undefined)
      setStrictEditingAids(undefined)
      setStrictBudgetSteering(undefined)
      setStrictAttempts(undefined)
      setStrictWallMinutes(undefined)
      setStrictExecutionTokens(undefined)
      setStrictReasoningTokens(undefined)
    })
  const resetAffective = () =>
    void resetTab("Affective", ["affective"], () => {
      setAffective(undefined)
      setAffTemperature(undefined)
      setAffExtended(undefined)
    })
  const resetIntrospection = () =>
    void resetTab("Introspection", ["introspection"], () => {
      setIntrospection(undefined)
      setIntrCadence(undefined)
      setIntrModel(undefined)
      setIntrPrompt(undefined)
      setIntrInterjection(undefined)
      setIntrGenerate(undefined)
    })

  const save = async () => {
    const id = props.agentID
    setSaving(true)
    try {
      // The ordinary config merge — one agent's fragment, layered like any other config write.
      // The id is NOT in this patch and never will be: it keys `agent:<id>`, so renaming it would
      // orphan the colleague from everything it remembers. A rename moves the NAME only.
      // ⚠️ Every key here is CONDITIONAL, and that is review D3. These five used to be sent
      // unconditionally from a `*Value()` accessor whose fallback chain is draft → stored → empty —
      // so while the screen's own roster fetch was still in flight, `agent()` was `undefined` and
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
        surgicalEdits?: boolean
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
        ...(surgicalEdits() === undefined ? {} : { surgicalEdits: surgicalEdits()! }),
      }
      // The three harness-detail structs, merged over what is STORED rather than sent as the
      // touched fragment alone: a `{ enabled }`-only write would wipe the levers, budgets and
      // prompts the officer already carries (the store patch-merges per agent, not per struct —
      // and this screen refuses to depend on which). Untouched tabs send nothing at all.
      const strictTouched =
        strict() !== undefined ||
        strictVerification() !== undefined ||
        strictRecovery() !== undefined ||
        strictEditingAids() !== undefined ||
        strictBudgetSteering() !== undefined ||
        strictAttempts() !== undefined ||
        strictWallMinutes() !== undefined ||
        strictExecutionTokens() !== undefined ||
        strictReasoningTokens() !== undefined
      const strictPatch = strictTouched
        ? mergeDraft(strictStored() as Record<string, unknown>, {
            enabled: strict(),
            verification: strictVerification(),
            recovery: strictRecovery(),
            editingAids: strictEditingAids(),
            budgetSteering: strictBudgetSteering(),
            attempts: numTouched(strictAttempts()),
            wallMinutes: numTouched(strictWallMinutes()),
            executionTokens: numTouched(strictExecutionTokens()),
            reasoningTokens: numTouched(strictReasoningTokens()),
          })
        : undefined
      const affectiveTouched =
        affective() !== undefined || affTemperature() !== undefined || affExtended() !== undefined
      const affectivePatch = affectiveTouched
        ? mergeDraft(affStored() as Record<string, unknown>, {
            enabled: affective(),
            temperature: numTouched(affTemperature()),
            extended: affExtended(),
          })
        : undefined
      const introspectionTouched =
        introspection() !== undefined ||
        intrCadence() !== undefined ||
        intrModel() !== undefined ||
        intrPrompt() !== undefined ||
        intrInterjection() !== undefined ||
        intrGenerate() !== undefined
      const introspectionPatch = introspectionTouched
        ? mergeDraft(intrStored() as Record<string, unknown>, {
            enabled: introspection(),
            cadence: numTouched(intrCadence()),
            // `""` is the inherit choice and `mergeDraft` deletes it — the judge then runs on
            // the active turn's model, which is what "use the active model" promises.
            model: intrModel(),
            prompt: textTouched(intrPrompt()),
            interjection: textTouched(intrInterjection()),
            generateInterjection: intrGenerate(),
          })
        : undefined
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
            ...(job() === undefined && agent()?.system === undefined ? {} : { system: jobValue() }),
            memory: memoryValue(),
            // Sent as `""` when cleared, which the config decoder stores as "no folder" — the field is
            // optional, so an empty string is how a UI says "unset" through a merge patch.
            // A pure Chat role has no project component. Clear an old assignment even when this
            // save changed another field, so a stale hidden folder cannot spring back later.
            ...(governing()
              ? {}
              : postureValue() !== "agent"
                ? { directory: "" }
                : directory() === undefined
                  ? {}
                  : { directory: directory()!.trim() }),
            ...(posture() === undefined ? {} : { kind: posture()! }),
            ...(permissionMode() === undefined ? {} : { permissionMode: permissionMode()! }),
            ...(strictPatch === undefined ? {} : { strict: strictPatch }),
            ...(affectivePatch === undefined ? {} : { affective: affectivePatch }),
            ...(introspectionPatch === undefined ? {} : { introspection: introspectionPatch }),
            ...(operationMode() === undefined ? {} : { operationMode: operationMode()! }),
            ...(goal() === undefined ? {} : { goal: goalValue() }),
            ...(toolLabels() === undefined ? {} : { toolLabels: toolLabels()! }),
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
      setSurgicalEdits(undefined)
      setIntrospection(undefined)
      setAffective(undefined)
      setStrictVerification(undefined)
      setStrictRecovery(undefined)
      setStrictEditingAids(undefined)
      setStrictBudgetSteering(undefined)
      setStrictAttempts(undefined)
      setStrictWallMinutes(undefined)
      setStrictExecutionTokens(undefined)
      setStrictReasoningTokens(undefined)
      setAffTemperature(undefined)
      setAffExtended(undefined)
      setIntrCadence(undefined)
      setIntrModel(undefined)
      setIntrPrompt(undefined)
      setIntrInterjection(undefined)
      setIntrGenerate(undefined)
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
    <div
      data-component="agent-settings"
      class="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base"
    >
      <div
        data-slot="agent-settings-header"
        class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-v2-border-border-base px-3 py-2 sm:px-4"
      >
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
          id={props.agentID}
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
        <button
          type="button"
          class="shrink-0 rounded-md p-1.5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base"
          aria-label={language.t("agentHelp.title")}
          title={language.t("agentHelp.title")}
          onClick={() => openHelp()}
        >
          <Icon name="help" class="size-4" />
        </button>
        <div
          data-slot="agent-settings-actions"
          class="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto sm:shrink-0"
        >
          <button
            type="button"
            data-action="agent-pause"
            class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
            disabled={saving() || busy() !== undefined || agent() === undefined}
            onClick={() => void setPaused(agent()?.paused !== true)}
          >
            {busy() === "pause"
              ? language.t("agentConfig.pausing")
              : language.t(agent()?.paused === true ? "agentConfig.resume" : "agentConfig.pause")}
          </button>
          <Show when={!governing()}>
            <button
              type="button"
              data-action="agent-clone"
              class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
              disabled={saving() || busy() !== undefined || agent() === undefined}
              onClick={() => void clone()}
            >
              {busy() === "clone" ? language.t("agentConfig.cloning") : language.t("agentConfig.clone")}
            </button>
            <button
              type="button"
              data-action="agent-retire"
              class="rounded-md px-2.5 py-1.5 text-xs text-v2-state-fg-danger hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
              disabled={saving() || busy() !== undefined || agent() === undefined}
              onClick={() => void retire()}
            >
              {busy() === "retire" ? language.t("agentConfig.retiring") : language.t("agentConfig.retire")}
            </button>
          </Show>
          <span aria-hidden="true" class="mx-1 h-4 border-l border-v2-border-border-base" />
          <button
            type="button"
            data-action="agent-config-cancel"
            class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
            onClick={props.onDismiss}
          >
            {language.t("agentConfig.cancel")}
          </button>
          <button
            type="button"
            data-action="agent-config-save"
            class="rounded-md border border-v2-border-border-strong bg-v2-background-bg-layer-03 px-3 py-1.5 text-xs font-semibold text-v2-text-text-base shadow-sm hover:brightness-110 disabled:opacity-40"
            disabled={
              !dirty() ||
              !reasoningBudgetValid() ||
              !maxToolTimeoutValid() ||
              !strictAttemptsValid() ||
              !strictWallMinutesValid() ||
              !strictExecutionTokensValid() ||
              !strictReasoningTokensValid() ||
              !affTemperatureValid() ||
              !intrCadenceValid() ||
              Number.isNaN(parsedMaxWorkers()) ||
              Number.isNaN(parsedSpawnDepth()) ||
              Number.isNaN(parsedRuntimeHeartbeatMinutes()) ||
              saving() ||
              busy() !== undefined ||
              agent() === undefined
            }
            onClick={() => void save()}
          >
            {saving() ? language.t("agentConfig.saving") : language.t("agentConfig.save")}
          </button>
        </div>
      </div>

      <KobalteTabs
        value={activeTab()}
        onChange={(value) => setActiveTab(value as SettingsTab)}
        orientation={desktopSettings() ? "vertical" : "horizontal"}
        class="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden md:flex-row"
      >
        <KobalteTabs.List
          as="nav"
          data-slot="agent-settings-nav"
          class="flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 md:w-44 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:px-2 md:py-3"
          aria-label="Officer settings"
        >
          <For each={settingsTabs()}>
            {(tab) => (
              <KobalteTabs.Trigger
                type="button"
                value={tab.id}
                data-active={activeTab() === tab.id}
                class={`flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-transparent px-2.5 text-left text-xs transition-colors md:min-h-9 ${
                  activeTab() === tab.id
                    ? "bg-v2-background-bg-layer-03 font-medium text-v2-text-text-base shadow-sm"
                    : "text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                }`}
              >
                <Icon name={tab.icon} class="hidden size-4 shrink-0 sm:block" />
                <span>{tab.label}</span>
              </KobalteTabs.Trigger>
            )}
          </For>
        </KobalteTabs.List>
        <KobalteTabs.Content
          value={activeTab()}
          class="agent-settings-panels min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4 md:px-5 md:py-4"
          data-active-tab={activeTab()}
        >
          <div class="mx-auto w-full max-w-4xl">
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
                  Import profile
                </button>
                <button
                  type="button"
                  data-action="agent-personality-export"
                  class="w-full rounded-md px-3 py-2 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 sm:w-auto"
                  onClick={exportPersonality}
                >
                  Export profile
                </button>
              </div>
              <p class="mt-2 text-[11px] leading-relaxed text-v2-text-text-faint">
                Exports identity and job only.
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
                  makes this field inert for Nova — and the rule this screen already states is that a
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
                <p class="text-[11px] text-v2-text-text-faint">{language.t(memoryKey(memoryValue()))}</p>
                {/* The filing cabinet and its destructive action belong beside the switch that
                    governs it. On a phone these stack into two full-width, easy targets; from `sm`
                    upward they collapse into one quiet action row. */}
                <div class="mt-4 flex flex-col gap-2 border-t border-v2-border-border-muted pt-4 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    data-action="agent-open-memory"
                    class="w-full rounded-md bg-v2-background-bg-layer-03 px-3 py-2 text-xs font-medium text-v2-text-text-accent hover:bg-v2-background-bg-layer-02 disabled:opacity-40 sm:w-auto"
                    disabled={busy() !== undefined}
                    onClick={() => {
                      navigate(ownerRoute(props.agentID))
                    }}
                  >
                    {language.t("agentConfig.memoryOpen")}
                  </button>
                  <button
                    type="button"
                    data-action="agent-clear-memory"
                    class="w-full rounded-md px-3 py-2 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40 sm:w-auto"
                    disabled={busy() !== undefined}
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
              <p class="mt-1 text-[11px] text-v2-text-text-faint">Optional model for private reasoning.</p>
              <label class="mt-3 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={toolLabelsValue()}
                  onChange={(event) => setToolLabels(event.currentTarget.checked)}
                />
                <span>{language.t("agentConfig.toolLabels")}</span>
              </label>
              <Show when={toolLabelsValue()}>
                <p class="text-[11px] text-v2-text-text-faint">Adds one model call per command.</p>
              </Show>
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
            </section>

            <Show when={postureValue() === "agent"}>
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
                even when assigned to a project — `AgentPlugin.scratchDirsFor` grants it and its prompt
                names it — so the notes, drafts and probe scripts it writes there were real files nobody
                had a way to open.

                ⚠️ Rendered whether or not a project is assigned, because the workspace exists either
                way: when there is no project it IS the working folder, and when there is one it is the
                place the colleague keeps everything that is not the project's. Hiding it in the second
                case would hide exactly the files the user has no other route to. */}
                <Show when={workspacePath()}>
                  {(path) => (
                    <a
                      data-action="browse-workspace"
                      href={`/files?path=${encodeURIComponent(path())}`}
                      onClick={(event) => {
                        event.preventDefault()
                        navigate(`/files?path=${encodeURIComponent(path())}`)
                      }}
                      class="mt-2 inline-flex items-center gap-1.5 text-[11px] text-v2-text-text-faint underline hover:text-v2-text-text-base"
                    >
                      <Icon name="folder" class="size-3 shrink-0" />
                      {language.t("agentConfig.browseWorkspace", { name: name() })}
                    </a>
                  )}
                </Show>
              </section>
            </Show>

            <section class="agent-settings-card" data-section="work" data-settings-tab="work">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                {language.t("agentConfig.work")}
              </h3>
              <div class="mt-2 flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span>{language.t("agentConfig.posture")}</span>
                  <SelectV2
                    appearance="inline"
                    aria-label={language.t("agentConfig.posture")}
                    options={MODE_CHOICES}
                    current={modeValue()}
                    label={(value) =>
                      value === "interactive"
                        ? language.t("agentConfig.mode.interactive")
                        : value === "agent"
                          ? language.t("agentConfig.mode.agent")
                          : language.t(`prompt.posture.${value}.title`)
                    }
                    onSelect={(value) => {
                      if (!value) return
                      selectMode(value)
                    }}
                  />
                </div>
                <Show when={postureValue() !== "agent"}>
                  <p class="text-[11px] text-v2-text-text-faint">
                    {language.t(`prompt.posture.${postureValue()}.description`)}
                  </p>
                </Show>
                <Show when={modeValue() === "agent"}>
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
                  </label>
                </Show>

                <details class="mt-2 border-t border-v2-border-border-muted pt-3">
                  <summary class="cursor-pointer text-xs font-medium">Copy tuning</summary>
                  <div class="mt-2 flex items-center gap-2">
                    <SelectV2
                      aria-label="Prototype officer"
                      class="min-w-0 flex-1"
                      options={[
                        { key: "none", value: "", label: "Choose an officer…" },
                        ...copyCandidates().map((candidate) => ({
                          key: candidate.id,
                          value: candidate.id,
                          label: `${candidate.name?.trim() || displayName(candidate.id)} · ${candidate.title ?? language.t("agentConfig.noTitle")}`,
                        })),
                      ]}
                      current={
                        [
                          { key: "none", value: "", label: "Choose an officer…" },
                          ...copyCandidates().map((candidate) => ({
                            key: candidate.id,
                            value: candidate.id,
                            label: `${candidate.name?.trim() || displayName(candidate.id)} · ${candidate.title ?? language.t("agentConfig.noTitle")}`,
                          })),
                        ].find((option) => (option.value || undefined) === copySource()) ?? {
                          key: "none",
                          value: "",
                          label: "Choose an officer…",
                        }
                      }
                      value={(option) => option.key}
                      label={(option) => option.label}
                      onSelect={(option) => setCopySource(option && option.value !== "" ? option.value : undefined)}
                    />
                    <button
                      type="button"
                      data-action="agent-copy-tuning"
                      class="shrink-0 rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs font-medium disabled:opacity-40"
                      disabled={copySource() === undefined || dirty() || busy() !== undefined}
                      onClick={() => void copyTuning()}
                    >
                      {busy() === "copy" ? "Copying…" : "Copy"}
                    </button>
                  </div>
                  <Show when={dirty() && copySource() !== undefined}>
                    <p class="mt-1 text-[11px] text-v2-state-fg-warning">
                      Save or cancel your edits first — a copy written now would lose to them.
                    </p>
                  </Show>
                </details>
                <button
                  type="button"
                  class="self-start rounded-md px-1 py-1 text-xs text-v2-text-text-faint hover:text-v2-text-text-base disabled:opacity-40"
                  disabled={officerSessionID() === undefined || sdk() === undefined}
                  onClick={() => void exportOfficerPrompt()}
                >
                  {language.t("context.export.prompt")}
                </button>
              </div>
            </section>

            <section class="agent-settings-card" data-section="context" data-settings-tab="context">
              <Show when={activeTab() === "context" ? props.agentID : undefined} keyed>
                {(id) => <OfficerContext agentID={id} config={() => agent()?.config as Record<string, unknown> | undefined} onChanged={props.onChanged} />}
              </Show>
            </section>

            <section class="agent-settings-card" data-section="quality" data-settings-tab="quality">
              <Show when={activeTab() === "quality" ? props.agentID : undefined} keyed>
                {(id) => <OfficerQuality agentID={id} config={() => agent()?.config as Record<string, unknown> | undefined} directory={directoryValue} onChanged={props.onChanged} />}
              </Show>
            </section>

            <section class="agent-settings-card" data-section="strict" data-settings-tab="quality">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">Strict harness</h3>
              <label class="mt-3 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={strictValue()}
                  onChange={(event) => setStrict(event.currentTarget.checked)}
                />
                <span>
                  <span class="block">{language.t("agentConfig.strict")}</span>
                  <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                    The harness owns decomposition and verifies each step — for small models that lose the horizon, not
                    the knowledge.
                  </span>
                </span>
              </label>
              <div class="mt-3 flex flex-col gap-2 border-t border-v2-border-border-muted pt-3">
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={strictVerificationValue()}
                    onChange={(event) => setStrictVerification(event.currentTarget.checked)}
                  />
                  <span>Verification gates</span>
                </label>
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={strictRecoveryValue()}
                    onChange={(event) => setStrictRecovery(event.currentTarget.checked)}
                  />
                  <span>Recovery and keep-best</span>
                </label>
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={strictEditingAidsValue()}
                    onChange={(event) => setStrictEditingAids(event.currentTarget.checked)}
                  />
                  <span>Editing aids</span>
                </label>
                <label class="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={strictBudgetSteeringValue()}
                    onChange={(event) => setStrictBudgetSteering(event.currentTarget.checked)}
                  />
                  <span>Time-budget steering</span>
                </label>
              </div>
              <div class="mt-3 grid gap-3 border-t border-v2-border-border-muted pt-3 sm:grid-cols-2">
                <label class="block text-xs text-v2-text-text-muted">
                  Parallel attempts (race)
                  <input
                    aria-label="Parallel attempts"
                    class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                    type="number"
                    min="1"
                    max="8"
                    step="1"
                    value={strictAttemptsValue()}
                    placeholder="1"
                    onInput={(event) => setStrictAttempts(event.currentTarget.value)}
                  />
                </label>
                <label class="block text-xs text-v2-text-text-muted">
                  Time budget (minutes)
                  <input
                    aria-label="Strict time budget in minutes"
                    class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                    type="number"
                    min="1"
                    max="480"
                    step="1"
                    value={strictWallMinutesValue()}
                    placeholder="45"
                    onInput={(event) => setStrictWallMinutes(event.currentTarget.value)}
                  />
                </label>
                <label class="block text-xs text-v2-text-text-muted">
                  Execution budget (tokens)
                  <input
                    aria-label="Strict execution budget in tokens"
                    class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                    type="number"
                    min="0"
                    step="1024"
                    value={strictExecutionTokensValue()}
                    placeholder="24576"
                    onInput={(event) => setStrictExecutionTokens(event.currentTarget.value)}
                  />
                </label>
                <label class="block text-xs text-v2-text-text-muted">
                  Reasoning budget (tokens)
                  <input
                    aria-label="Strict reasoning budget in tokens"
                    class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                    type="number"
                    min="0"
                    step="1024"
                    value={strictReasoningTokensValue()}
                    placeholder="0"
                    onInput={(event) => setStrictReasoningTokens(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div class="mt-3 border-t border-v2-border-border-muted pt-3">
                <button
                  type="button"
                  data-action="agent-reset-strict"
                  class="rounded-md px-2 py-1.5 text-xs text-v2-text-text-faint hover:bg-v2-background-bg-layer-03"
                  onClick={() => void resetStrict()}
                >
                  {language.t("agentConfig.resetTab.action")}
                </button>
              </div>
            </section>

            <section class="agent-settings-card" data-section="affective" data-settings-tab="mind">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">Affective</h3>
              <label class="mt-3 flex items-start gap-2 text-xs">
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
              <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-v2-border-border-muted pt-3 text-xs">
                <span class="min-w-0">Calm-baseline temperature</span>
                <PresetFieldV2
                  field="temperature"
                  value={affTemperatureValue}
                  onValue={(next) => setAffTemperature(next)}
                  ariaLabel="Calm-baseline temperature"
                />
              </div>
              <label class="mt-3 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={affExtendedValue()}
                  onChange={(event) => setAffExtended(event.currentTarget.checked)}
                />
                <span>
                  <span class="block">Extended parameters</span>
                  <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                    Also modulate extended sampling parameters, for engines that accept them.
                  </span>
                </span>
              </label>
              <div class="mt-3 border-t border-v2-border-border-muted pt-3">
                <button
                  type="button"
                  data-action="agent-reset-affective"
                  class="rounded-md px-2 py-1.5 text-xs text-v2-text-text-faint hover:bg-v2-background-bg-layer-03"
                  onClick={() => void resetAffective()}
                >
                  {language.t("agentConfig.resetTab.action")}
                </button>
              </div>
            </section>

            <section class="agent-settings-card" data-section="introspection" data-settings-tab="mind">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">Introspection</h3>
              <label class="mt-3 flex items-start gap-2 text-xs">
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
              <label class="mt-3 block text-xs text-v2-text-text-muted">
                Judge every N continuation steps
                <input
                  aria-label="Introspection cadence"
                  class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                  type="number"
                  min="1"
                  step="1"
                  value={intrCadenceValue()}
                  placeholder="3"
                  onInput={(event) => setIntrCadence(event.currentTarget.value)}
                />
              </label>
              <label class="mt-3 block text-xs text-v2-text-text-muted">Judge model</label>
              <SelectV2
                aria-label="Judge model"
                class="mt-1 w-full"
                options={intrModelOptions()}
                current={
                  intrModelOptions().find((option) => option.value === intrModelValue()) ?? intrModelOptions()[0]
                }
                value={(option) => option.key}
                label={(option) => option.label}
                onSelect={(option) => option && setIntrModel(option.value)}
              />
              <label class="mt-3 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={intrGenerateValue()}
                  onChange={(event) => setIntrGenerate(event.currentTarget.checked)}
                />
                <span>
                  <span class="block">Judge writes the interjection</span>
                  <span class="mt-1 block text-[11px] leading-relaxed text-v2-text-text-faint">
                    Otherwise the fixed text below is steered in.
                  </span>
                </span>
              </label>
              <label class="mt-3 block text-xs text-v2-text-text-muted">
                The question the judge is asked
                <textarea
                  aria-label="Introspection prompt"
                  class="mt-1 min-h-20 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                  value={intrPromptValue()}
                  onInput={(event) => setIntrPrompt(event.currentTarget.value)}
                  placeholder="Judge ONLY whether the agent is stuck…"
                />
              </label>
              <label class="mt-3 block text-xs text-v2-text-text-muted">
                Interjection on “stuck”
                <textarea
                  aria-label="Introspection interjection"
                  class="mt-1 min-h-16 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
                  value={intrInterjectionValue()}
                  onInput={(event) => setIntrInterjection(event.currentTarget.value)}
                  placeholder="Stop repeating the same approach…"
                />
              </label>
              <div class="mt-3 border-t border-v2-border-border-muted pt-3">
                <button
                  type="button"
                  data-action="agent-reset-introspection"
                  class="rounded-md px-2 py-1.5 text-xs text-v2-text-text-faint hover:bg-v2-background-bg-layer-03"
                  onClick={() => void resetIntrospection()}
                >
                  {language.t("agentConfig.resetTab.action")}
                </button>
              </div>
            </section>

            <section class="agent-settings-card" data-settings-tab="capabilities" data-section="workers">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">Capabilities</h3>
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span>{language.t("prompt.permissionMode.title")}</span>
                  <SelectV2
                    appearance="inline"
                    aria-label={language.t("prompt.permissionMode.title")}
                    options={PERMISSION_MODE_CHOICES}
                    current={
                      PERMISSION_MODE_CHOICES.find((mode) => mode === permissionModeValue()) ??
                      PERMISSION_MODE_CHOICES[2]
                    }
                    label={(mode) => language.t(`prompt.permissionMode.${mode}`)}
                    onSelect={(mode) => mode && setPermissionMode(mode)}
                  />
                </div>
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
                  <span class="mt-1 block text-[11px] text-v2-text-text-faint">0 disables spawning.</span>
                </label>
              </div>
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
                <p class="mt-1 text-[11px] text-v2-text-text-faint">Workers inherit this limit.</p>
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
                </Show>

              <label class="mt-3 block text-xs text-v2-text-text-muted">Worker prototype</label>
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
              <label class="mt-3 block text-xs text-v2-text-text-muted">Worker model</label>
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
            </section>

            <section class="agent-settings-card" data-section="tools" data-settings-tab="capabilities">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">Tools</h3>
              <div class="mt-2 flex flex-col gap-1.5">
                <For each={Object.entries(officerTools())}>
                  {([tool, enabled]) => (
                    <div class="flex items-center justify-between gap-2 text-xs">
                      <span class="min-w-0 truncate font-mono">{tool}</span>
                      <span class="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          data-action={enabled ? "agent-tool-restore" : "agent-tool-deny"}
                          class={`rounded-md px-2 py-1 text-[11px] ${enabled ? "bg-v2-background-bg-layer-03" : "text-v2-text-text-faint hover:bg-v2-background-bg-layer-02"}`}
                          aria-label={enabled ? `Deny ${tool} for this officer` : `Restore ${tool} for this officer`}
                          onClick={() => setHorizonTool(tool, !enabled)}
                        >
                          {enabled ? "Allowed" : "Denied"}
                        </button>
                        <button
                          type="button"
                          data-action="agent-tool-forget"
                          class="rounded-md px-2 py-1 text-[11px] text-v2-text-text-faint hover:bg-v2-background-bg-layer-02"
                          aria-label={`Use default routing for ${tool}`}
                          onClick={() => setHorizonTool(tool, undefined)}
                        >
                          Default
                        </button>
                      </span>
                    </div>
                  )}
                </For>
                <Show when={Object.keys(officerTools()).length === 0}>
                  <p class="text-[11px] text-v2-text-text-faint">No tool overrides.</p>
                </Show>
              </div>
              <Show when={horizonSuggestions().length > 0}>
                <div class="mt-2 flex flex-wrap gap-1">
                  <For each={horizonSuggestions()}>
                    {(tool) => (
                      <button
                        type="button"
                        class="rounded-md bg-v2-background-bg-layer-03 px-2 py-1 text-[11px] hover:bg-v2-background-bg-layer-02"
                        aria-label={`Deny ${tool} for this officer`}
                        onClick={() => setHorizonTool(tool, false)}
                      >
                        − {tool}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <div class="mt-2 flex items-center gap-2">
                <TextInputV2
                  class="min-w-0 flex-1"
                  value={horizonAdd()}
                  placeholder="Another tool name…"
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  onInput={(event) => setHorizonAdd(event.currentTarget.value)}
                  aria-label="Deny another tool by name"
                />
                <button
                  type="button"
                  data-action="agent-tool-add"
                  class="shrink-0 rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1.5 text-xs disabled:opacity-40"
                  disabled={horizonAdd().trim() === ""}
                  onClick={() => {
                    const name = horizonAdd().trim()
                    if (name) setHorizonTool(name, false)
                    setHorizonAdd("")
                  }}
                >
                  Deny
                </button>
              </div>
              <OfficerRecipes agentID={props.agentID} recipes={officerRecipes} />
            </section>

            <section class="agent-settings-card" data-settings-tab="nudges" data-section="nudges">
              <SettingsNudgesV2 fixedAgentID={props.agentID} />
            </section>

            <Show when={activeTab() === "schedule" && postureValue() === "agent" ? props.agentID : undefined} keyed>
              {(id) => (
                <section class="agent-settings-card" data-settings-tab="schedule" data-section="schedule">
                  <SettingsScheduleV2 agentID={id} />
                </section>
              )}
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

            <section class="agent-settings-card" data-settings-tab="messengers" data-section="messengers">
              <Show when={activeTab() === "messengers" ? props.agentID : undefined} keyed>
                {(id) => <OfficerMessengers agentID={id} />}
              </Show>
              <div class="mt-4 rounded-xl border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3 sm:p-4">
                <AgentRemoteChat agentID={props.agentID} sessionID={officerSessionID} ensureSession={ensureOfficerSession} />
              </div>
            </section>

          </div>
        </KobalteTabs.Content>
      </KobalteTabs>
    </div>
  )
}
