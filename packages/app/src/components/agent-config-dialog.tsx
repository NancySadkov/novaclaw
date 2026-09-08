import type { ConfigV2Agent } from "@novaclaw/sdk/v2/client"
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { ControlScope } from "@/components/control-scope"
import { useConfirm } from "@/components/dialog-confirm"
import { useDirectoryPicker } from "@/components/directory-picker"
import { displayName as folderDisplayName } from "@/pages/layout/helpers"
import { Icon } from "@novaclaw/ui/v2/icon"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { listSessions, startChat } from "@/apps/agent-list"
import { briefTooBigForTier, isTier, modelRef, parseModelRef, TIER_CHOICES } from "@/apps/agent-model"
import { useModels } from "@/context/models"
import { cloneAgent, isNovaCloneRefusal } from "@/apps/agent-clone"
import { chatFor, chatToClear } from "@/apps/roster-live"
import { GOVERNING_ID, displayName, memoryDisclosure, superiorCandidates, type AgentLike } from "@/apps/contacts"
import { MEMORY_COUNT_CAP, memoryCountLabel, ownerRoute } from "@/apps/memory-owner"
import { memoryList } from "@/utils/memory-api"
import { useLocation, useNavigate } from "@solidjs/router"
import { AgentPortrait } from "@/components/agent-portrait"
import { AGENT_AVATAR_TYPES, removeAgentAvatar, uploadAgentAvatar } from "@/apps/agent-avatar"
import { isAgentPortraitURL } from "@/apps/agent-portrait"
import { AgentHelpDialog } from "@/components/agent-help-dialog"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { tabHref, useTabs } from "@/context/tabs"
import { ServerConnection } from "@/context/server"

// ONE agent configuration dialog, opened from two places (AGENTS.md → *the structural metaphor*;
// `notes/named-agents.md`).
//
// 🔴 **This is where the composer's Tune button now leads.** Tune used to be a chat-scoped popover
// under the message box, which said the quiet part: settings belonged to a *conversation*. Under the
// roster they belong to a *colleague* — its brief, its personality, what it remembers — and the chat
// only carries how this particular conversation runs. So the button opens the colleague's config,
// with the chat's own controls as a section inside it rather than the whole of it.
//
// ⚠️ **A field the system would discard is not rendered as editable.** The governing agent's profile
// is fixed in code and a config write naming it is dropped at materialisation, so those inputs are
// read-only here and say why. Offering an input whose value goes nowhere is worse than offering
// nothing: the user does the work, sees no error, and learns not to trust the surface.

export function AgentConfigDialog(props: {
  /** Which colleague. `undefined` while a chat is still resolving its agent. */
  agentID: string | undefined
  onDismiss: () => void
  /**
   * Something about the roster CHANGED — a hire, a retirement, a cleared chat, a saved profile.
   *
   * ⚠️ The dialog cannot refetch the list it was opened from, and without this it does not try:
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

  /**
   * How much this colleague remembers, for the door below.
   *
   * ⚠️ Capped and COUNTED HERE rather than asked for as a statistic: `memory/stats` is instance-wide
   * and would answer with the household's total, which on this surface reads as "Spectre remembers
   * 4,000 things". A capped list is the honest cheap answer — past the cap the label says "many",
   * and no number on this dialog is ever larger than the colleague's own cabinet.
   */
  const [remembered] = createResource(
    () => {
      const current = conn()
      const id = props.agentID
      return current && id ? { cn: current, id, dir: sync().data.path?.directory ?? "" } : undefined
    },
    ({ cn, id, dir }) =>
      memoryList(cn.http, { directory: dir, scopes: [`agent:${id}`], limit: MEMORY_COUNT_CAP })
        .then((rows) => rows.length)
        .catch(() => undefined),
  )
  const name = createMemo(() => agent()?.name?.trim() || (props.agentID ? displayName(props.agentID) : ""))

  // Drafts start empty and fall back to the stored value at render, so an edit survives a re-read of
  // the roster while an untouched field keeps tracking the server.
  const [renamed, setRenamed] = createSignal<string | undefined>()
  const [title, setTitle] = createSignal<string | undefined>()
  const [personality, setPersonality] = createSignal<string | undefined>()
  const [avatarFile, setAvatarFile] = createSignal<File | undefined>()
  const [avatarRemoved, setAvatarRemoved] = createSignal(false)
  const [memory, setMemory] = createSignal<"own" | "none" | undefined>()
  const [archive, setArchive] = createSignal<boolean | undefined>()
  const [model, setModel] = createSignal<string | undefined>()
  const [reasoningBudget, setReasoningBudget] = createSignal<string | undefined>()
  const [needsTier, setNeedsTier] = createSignal<string | undefined>()
  const [superior, setSuperior] = createSignal<string | undefined>()
  // `""` is a real value here and means "back to its own scratch" — distinct from `undefined`, which
  // means "the user has not touched this field". Collapsing the two would make Clear indistinguishable
  // from Cancel.
  const [directory, setDirectory] = createSignal<string | undefined>()
  const [posture, setPosture] = createSignal<boolean | undefined>()
  const [permissionMode, setPermissionMode] = createSignal<string | undefined>()
  const [strict, setStrict] = createSignal<boolean | undefined>()
  const [reground, setReground] = createSignal<boolean | undefined>()
  const models = useModels()
  const [saving, setSaving] = createSignal(false)
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
  const memoryValue = () => memory() ?? agent()?.memory ?? "own"
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
  const regroundValue = () => reground() ?? (agent()?.config?.["reground"] as boolean | undefined) ?? true
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
  // "" is the INHERIT choice, and it is a real value rather than a missing one: a colleague with no
  // model of its own follows the instance default, which is a decision the user can return to.
  const modelValue = () => {
    const chosen = model()
    if (chosen !== undefined) return chosen
    const bound = agent()?.model
    return bound ? modelRef(bound) : ""
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
  const superiorValue = () => superior() ?? agent()?.superior ?? ""
  const boundTier = createMemo(() => {
    const ref = parseModelRef(modelValue())
    if (ref === undefined) return undefined
    const found = models.list().find((item) => item.id === ref.id && item.provider.id === ref.providerID) as
      | { tier?: unknown }
      | undefined
    return isTier(found?.tier) ? found.tier : undefined
  })
  const needsTierValue = () => {
    const chosen = needsTier()
    if (chosen !== undefined) return chosen
    const declared = (agent()?.config as Record<string, unknown> | undefined)?.["needsTier"]
    return typeof declared === "string" ? declared : ""
  }
  /** Is the model bound above ALREADY beneath the floor chosen here? Shown live, in the dialog where
   *  both choices are made — the colleague's own notice arrives in its chat, which is the right place
   *  for the model but the wrong place for the person setting this up. */
  const belowFloor = createMemo(() => {
    const needs = needsTierValue()
    const bound = boundTier()
    if (needs === "" || bound === undefined) return false
    return TIER_CHOICES.indexOf(bound as (typeof TIER_CHOICES)[number]) < TIER_CHOICES.indexOf(needs as never)
  })
  // The one thing a product whose user picks the model can say, and a vendor-chosen one cannot.
  const mindTooSmall = createMemo(() =>
    briefTooBigForTier({
      brief: personalityValue() || agent()?.system,
      personality: personalityValue(),
      tier: boundTier(),
    }),
  )
  const dirty = () =>
    renamed() !== undefined ||
    title() !== undefined ||
    personality() !== undefined ||
    memory() !== undefined ||
    directory() !== undefined ||
    posture() !== undefined ||
    permissionMode() !== undefined ||
    strict() !== undefined ||
    archive() !== undefined ||
    needsTier() !== undefined ||
    model() !== undefined ||
    reasoningBudget() !== undefined ||
    superior() !== undefined ||
    avatarFile() !== undefined ||
    avatarRemoved()

  const [busy, setBusy] = createSignal<"clone" | "clear" | "retire" | "pause" | undefined>()

  const sdk = () => ctx()?.sdk.client.v2

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
       */
      const chat = chatToClear(sessions, id, location.pathname)
      if (chat === undefined) {
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
      const removed = await client.session.remove({ sessionID: chat.id })
      if (removed.error) throw removed.error
      const viewingCleared = location.pathname.includes(chat.id)
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
        // is the dead end this whole path exists to avoid.
        tabs.closeSessionTab(key, chat.id)
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
    if (id === undefined || governing()) return
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
    if (id === undefined || governing()) return
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
      const tier = needsTierValue()
      const binding: Pick<ConfigV2Agent, "model" | "needsTier"> & { reasoningBudget?: number } = {
        ...(modelValue() === "" ? {} : { model: modelValue() }),
        ...(needsTier() === undefined || !isTier(tier) ? {} : { needsTier: tier }),
        ...(reasoningBudget() === undefined || parsedReasoningBudget() === undefined
          ? {}
          : { reasoningBudget: parsedReasoningBudget() }),
      }
      await sync().updateConfig({
        agents: {
          [id]: {
            ...(renamed() === undefined && agent()?.name === undefined ? {} : { name: nameValue() }),
            ...(title() === undefined && agent()?.title === undefined ? {} : { title: titleValue() }),
            ...(personality() === undefined && agent()?.personality === undefined
              ? {}
              : { personality: personalityValue() }),
            memory: memoryValue(),
            // Sent as `""` when cleared, which the config decoder stores as "no folder" — the field is
            // optional, so an empty string is how a UI says "unset" through a merge patch.
            ...(directory() === undefined ? {} : { directory: directory()!.trim() }),
            ...(posture() === undefined ? {} : { shortChat: posture()! }),
            ...(permissionMode() === undefined ? {} : { permissionMode: permissionMode()! }),
            ...(strict() === undefined ? {} : { strict: { enabled: strict()! } }),
            ...(reground() === undefined ? {} : { reground: reground()! }),
            archiveChats: archiveValue(),
            ...(superior() === undefined || superior() === "" ? {} : { superior: superior()! }),
            ...binding,
          },
        },
      } as never)
      // Config patches preserve omitted fields and reject null. Returning to inheritance is a
      // deletion, and only an explicitly changed selector may request it.
      await sync().removeConfig([
        ...(model() === "" ? [["agents", id, "model"]] : []),
        ...(needsTier() === "" ? [["agents", id, "needsTier"]] : []),
        ...(reasoningBudget() === "" ? [["agents", id, "reasoningBudget"]] : []),
        ...(superior() === "" ? [["agents", id, "superior"]] : []),
      ])
      const current = conn()
      if (current === undefined) throw new Error("No instance is connected")
      if (avatarFile() !== undefined) await uploadAgentAvatar(current.http, id, avatarFile()!)
      else if (avatarRemoved()) await removeAgentAvatar(current.http, id)
      setRenamed(undefined)
      setTitle(undefined)
      setPersonality(undefined)
      setAvatarFile(undefined)
      setAvatarRemoved(false)
      setMemory(undefined)
      setDirectory(undefined)
      setPosture(undefined)
      setPermissionMode(undefined)
      setStrict(undefined)
      setReground(undefined)
      setArchive(undefined)
      setModel(undefined)
      setReasoningBudget(undefined)
      setSuperior(undefined)
      setNeedsTier(undefined)
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

  // Nova's charter is compiled into the instance, so it is a different kind of surface from an
  // officer profile: a projection, never a disabled edit form. Keeping the editable tree mounted
  // behind disabled controls still advertises values the store will refuse and leaves future
  // controls one forgotten `disabled` away from repeating the same defect. This branch makes the
  // forbidden write structurally unreachable and leaves a calm, useful surface with an obvious way
  // back.
  if (governing()) {
    return (
      <Dialog size="full">
        <div
          class="flex h-full w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base"
          data-agent-profile="governing-readonly"
        >
          <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-3">
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
            <ControlScope kind="colleague" class="hidden sm:inline-flex" />
            <button type="button" class="text-xs text-v2-text-text-muted hover:underline" onClick={props.onDismiss}>
              {language.t("agentConfig.close")}
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <div class="mx-auto flex w-full max-w-2xl flex-col gap-5">
              <section class="rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-5">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                  {language.t("agentConfig.who")}
                </h3>
                <p class="mt-2 text-sm text-v2-text-text-base">{language.t("agentConfig.governingLocked")}</p>
                <dl class="mt-5 grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt class="text-xs text-v2-text-text-muted">{language.t("agentConfig.name")}</dt>
                    <dd class="mt-1 text-sm">{nameValue()}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-v2-text-text-muted">{language.t("agentConfig.jobTitle")}</dt>
                    <dd class="mt-1 text-sm">{titleValue() || language.t("agentConfig.noTitle")}</dd>
                  </div>
                  <Show when={personalityValue()}>
                    {(value) => (
                      <div class="sm:col-span-2">
                        <dt class="text-xs text-v2-text-text-muted">{language.t("agentConfig.personality")}</dt>
                        <dd class="mt-1 whitespace-pre-wrap text-sm">{value()}</dd>
                      </div>
                    )}
                  </Show>
                </dl>
              </section>
              <Show when={props.tuning}>{(tuning) => tuning()()}</Show>
            </div>
          </div>
          {/* Nova's charter is immutable; Nova's conversation is not. Clear therefore remains an
              ordinary chat lifecycle action here, beside the deliberately instructive Clone door. */}
          <div class="flex items-center gap-2 border-t border-v2-border-border-muted px-4 py-2.5">
            <button
              type="button"
              data-action="agent-clear-chat"
              class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
              disabled={busy() !== undefined || props.agentID === undefined}
              onClick={() => void clearChat()}
            >
              {busy() === "clear" ? language.t("agentConfig.clearing") : language.t("agentConfig.clearChat")}
            </button>
            {/* Kept visible on purpose: pressing it teaches why a second Nova is a second INSTANCE,
                while `planClone` remains the enforcement seam for every caller. */}
            <button
              type="button"
              class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02"
              onClick={() => void clone()}
            >
              {language.t("agentConfig.clone")}
            </button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    // 🔴 A real MODAL, through the v2 `Dialog` shell — not a bare `<div>` (owner, 2026-08-23).
    //
    // Two different symptoms, one cause. The dialog stack mounts its layer with
    // `pointer-events: none` and relies on the dialog's own container to set `pointer-events: auto`
    // (`dialog-v2.css`); a bare div INHERITS the `none`, so every click on this panel fell through
    // to the overlay underneath and closed it — Tune opened and shut the instant you touched it.
    // And in Contacts, where it was rendered inline in the page flow instead, the same bare div
    // squeezed the roster sideways rather than covering it. The shell fixes both, and brings the
    // focus trap and the labelled surface a modal is supposed to have.
    <Dialog size="full">
      {/* 🔴 FULL SCREEN (owner, 2026-08-27). It was a 560px box with `max-h-[80vh]`, and a colleague's
          configuration does not fit one: the profile, memory, model, the folder assignment and this
          chat's own switches are five sections deep, so the controls below the fold were reachable
          only by scrolling a panel that did not look scrollable. The owner reported the folder picker
          as MISSING — it was rendered the whole time, three sections down. A surface people conclude
          is absent is not a layout preference.
          ⚠️ The Back button in the header is what makes this safe: full screen with only an overlay
          click to leave would be the dead end §1.4 warns about. It was already there. */}
      <div class="flex h-full w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base">
        <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-3">
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
          <ControlScope kind="colleague" class="hidden sm:inline-flex" />
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

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <section>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
              {language.t("agentConfig.who")}
            </h3>
            <Show
              when={!governing()}
              fallback={<p class="mt-2 text-xs text-v2-text-text-faint">{language.t("agentConfig.governingLocked")}</p>}
            >
              <label class="mt-2 block text-xs text-v2-text-text-muted">
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
              {/* Why this is a profile field and not something you type into the chat. */}
            </Show>
            <label class="mt-3 block text-xs text-v2-text-text-muted">
              {language.t("agentConfig.portrait")}
              <span class="mt-1 block text-[11px] text-v2-text-text-faint">
                {language.t("agentConfig.portraitHint")}
              </span>
              <input
                class="mt-2 block w-full text-xs"
                type="file"
                accept={[...AGENT_AVATAR_TYPES].join(",")}
                onChange={(event) => {
                  setAvatarFile(event.currentTarget.files?.[0])
                  setAvatarRemoved(false)
                }}
              />
              <Show when={isAgentPortraitURL(agent()?.avatar) || avatarFile() !== undefined}>
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
            </label>
          </section>

          <section class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
              {language.t("agentConfig.memory")}
            </h3>
            <div class="mt-2 flex flex-col gap-1.5">
              {/* Both halves, again — this is the surface where someone decides what a colleague keeps,
                  so it is the last place that should describe only the private half. */}
              <label class="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  class="mt-0.5"
                  checked={memoryValue() === "own"}
                  disabled={governing()}
                  onChange={() => setMemory("own")}
                />
                <span>{language.t(memoryDisclosure("own").privateKey)}</span>
              </label>
              <label class="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  class="mt-0.5"
                  checked={memoryValue() === "none"}
                  disabled={governing()}
                  onChange={() => setMemory("none")}
                />
                <span>{language.t(memoryDisclosure("none").privateKey)}</span>
              </label>

              {/* 🔴 The DOOR into this colleague's own cabinet.
                  Under the roster, "what does this colleague remember" is a question about a
                  COLLEAGUE, so it is asked here — the same move that brought Tune into this dialog.
                  Before it, the only way in was to open a global Memory app and find the name in a
                  picker: the shape of the chat list the roster replaced.
                  The count is live and says the honest thing when it is zero: a colleague that has
                  remembered nothing yet is the ordinary state of a new hire, not an error. */}
              <Show when={memoryValue() === "own"}>
                <button
                  type="button"
                  class="mt-1 self-start text-xs text-v2-text-text-accent hover:underline"
                  onClick={() => {
                    const id = props.agentID
                    if (id === undefined) return
                    props.onDismiss()
                    navigate(ownerRoute(id))
                  }}
                >
                  {memoryCountLabel(remembered()) === undefined
                    ? language.t("agentConfig.memoryOpen", { name: name() })
                    : language.t("agentConfig.memoryOpenCount", {
                        name: name(),
                        count: memoryCountLabel(remembered())!,
                      })}
                </button>
              </Show>
            </div>
          </section>

          <section class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
              {language.t("agentConfig.mind")}
            </h3>
            {/* 🔴 The model belongs to the COLLEAGUE, not to the chat. A chat-scoped model made the
                same colleague clever in one conversation and poor in the next, for reasons the user
                could not see. A colleague has one mind. */}
            <select
              aria-label={language.t("agentConfig.mind")}
              class="mt-2 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
              disabled={governing()}
              onChange={(event) => setModel(event.currentTarget.value)}
            >
              {/* ⚠️ `selected` per option, not `value` on the select — the SAME rule as the tier select
                  below and the composer's owner picker, and this was the one place that broke it
                  (review D2). Both halves of the race are live here: `agent()` is a resource, and
                  `models.list()` chains to the provider catalog's cold start. Solid compiles
                  `value={…}` to an effect that fires only when the VALUE changes, never when the
                  option list grows — so the colleague's bound model read "Inherit the instance
                  default" and the user confirmed a binding that was not the one in force. */}
              <option value="" selected={modelValue() === ""}>
                {language.t("agentConfig.modelInherit")}
              </option>
              <For each={models.list()}>
                {(item) => {
                  const ref = modelRef({ providerID: item.provider.id, id: item.id })
                  return (
                    <option value={ref} selected={modelValue() === ref}>
                      {item.name ?? item.id}
                    </option>
                  )
                }}
              </For>
            </select>
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
            {/* WARNS, never refuses: a small model doing a big job badly is the user's call, and
                sometimes the right one. */}
            <Show when={mindTooSmall()}>
              <p class="mt-1 text-[11px] text-v2-state-fg-warning">{language.t("agentConfig.modelTooSmall")}</p>
            </Show>
            {/* 🔴 The floor this ROLE needs, which is a different statement from the model bound above.
                A colleague can end up on the instance default without anyone choosing it — its own
                model may be unavailable or have been failing — and a bookkeeper written for a frontier
                model quietly thinking with a micro one does not error, it just gets things wrong. The
                floor is what lets the colleague notice and SAY so. */}
            <label class="mt-3 block text-xs text-v2-text-text-muted" for="agent-needs-tier">
              {language.t("agentConfig.needsTier")}
            </label>
            <select
              id="agent-needs-tier"
              class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
              disabled={governing()}
              onChange={(event) => setNeedsTier(event.currentTarget.value)}
            >
              {/* ⚠️ `selected` per option, not `value` on the select — the agent loads AFTER this
                  element is created, and a browser keeps `selectedIndex` at 0 when that happens. */}
              <option value="" selected={needsTierValue() === ""}>
                {language.t("agentConfig.needsTierNone")}
              </option>
              <For each={TIER_CHOICES}>
                {(tier) => (
                  <option value={tier} selected={needsTierValue() === tier}>
                    {language.t(`agentConfig.tier.${tier}`)}
                  </option>
                )}
              </For>
            </select>
            <Show when={belowFloor()}>
              <p class="mt-1 text-[11px] text-v2-state-fg-warning">{language.t("agentConfig.needsTierBelow")}</p>
            </Show>
            <label class="mt-3 block text-xs text-v2-text-text-muted" for="agent-superior">
              {language.t("agentConfig.superior")}
            </label>
            <select
              id="agent-superior"
              aria-label={language.t("agentConfig.superior")}
              class="mt-1 w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 text-sm"
              onChange={(event) => setSuperior(event.currentTarget.value)}
            >
              <option value="" selected={superiorValue() === "" || superiorValue() === GOVERNING_ID}>
                {language.t("agentConfig.superiorNova")}
              </option>
              <For each={superiorCandidates(agents() ?? [], props.agentID ?? "")}>
                {(candidate) => (
                  <option value={candidate.id} selected={superiorValue() === candidate.id}>
                    {candidate.name?.trim() || displayName(candidate.id)} ·{" "}
                    {candidate.title ?? language.t("agentConfig.noTitle")}
                  </option>
                )}
              </For>
            </select>
            <p class="mt-1 text-[11px] text-v2-text-text-faint">{language.t("agentConfig.superiorDescription")}</p>
          </section>

          <section class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
              {language.t("agentConfig.work")}
            </h3>
            {/* 🔴 The three standing WORK choices, moved off the composer 2026-08-21 (owner: the
                Chat/Agent drop-down, Strict and permissions "should be part of the agent too"). They
                describe the ROLE: a bookkeeper that needs Analyze mode needs it every time you talk to
                it, and re-choosing per chat is a question asked again for a decision that never
                changes. A chat can still differ — these are a LAYER, and the chat's own row wins. */}
            <div class="mt-2 flex flex-col gap-2">
              <label class="flex items-center justify-between gap-2 text-xs">
                <span>{language.t("agentConfig.posture")}</span>
                <select
                  class="rounded-md bg-v2-background-bg-layer-03 px-2 py-1 text-xs"
                  disabled={governing()}
                  onChange={(event) => setPosture(event.currentTarget.value === "chat")}
                >
                  <For each={["agent", "chat"] as const}>
                    {(value) => (
                      <option value={value} selected={(postureValue() ? "chat" : "agent") === value}>
                        {language.t(value === "chat" ? "prompt.posture.chat.title" : "prompt.posture.agent.title")}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <p class="text-[11px] text-v2-text-text-faint">
                {language.t(postureValue() ? "prompt.posture.chat.description" : "prompt.posture.agent.description")}
              </p>

              <label class="flex items-center justify-between gap-2 text-xs">
                <span>{language.t("prompt.permissionMode.title")}</span>
                <select
                  class="rounded-md bg-v2-background-bg-layer-03 px-2 py-1 text-xs"
                  disabled={governing()}
                  onChange={(event) => setPermissionMode(event.currentTarget.value)}
                >
                  <For each={["plan", "bypass", "yolo"] as const}>
                    {(mode) => (
                      <option value={mode} selected={permissionModeValue() === mode}>
                        {language.t(`prompt.permissionMode.${mode}`)}
                      </option>
                    )}
                  </For>
                </select>
              </label>

              <label class="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={strictValue()}
                  disabled={governing()}
                  onChange={(event) => setStrict(event.currentTarget.checked)}
                />
                <span>{language.t("agentConfig.strict")}</span>
              </label>
              <label class="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={regroundValue()}
                  disabled={governing()}
                  onChange={(event) => setReground(event.currentTarget.checked)}
                />
                <span>{language.t("agentConfig.reground")}</span>
              </label>
              <p class="text-[11px] text-v2-text-text-faint">{language.t("agentConfig.regroundDescription")}</p>
            </div>
          </section>

          <section class="mt-5">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
              {language.t("agentConfig.folder")}
            </h3>
            {/* 🔴 The colleague's PROJECT, and it lives here rather than in the prompt area (owner,
                2026-08-21). Asking which folder a chat runs in made "where does this work happen" a
                per-conversation question and left a named officer with no project of its own; under the
                roster it is part of the job — you assign the bookkeeper to the books once. */}
            <div class="mt-2 flex items-center gap-2">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-v2-background-bg-layer-03 px-2 py-1.5 text-left text-xs disabled:opacity-40"
                disabled={governing()}
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
          </section>

          <section class="mt-5">
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
                  disabled={governing() || memoryValue() === "none"}
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

          <Show when={props.tuning}>
            {(tuning) => (
              <section class="mt-5 border-t border-v2-border-border-muted pt-4">
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

        {/* Lifecycle, kept apart from the profile fields: these do something the moment they are
            pressed, while everything above waits for Save. */}
        <div class="flex flex-wrap items-center gap-2 border-t border-v2-border-border-muted px-4 py-2.5">
          <button
            type="button"
            data-action="agent-clear-chat"
            class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
            disabled={busy() !== undefined || props.agentID === undefined}
            onClick={() => void clearChat()}
          >
            {busy() === "clear" ? language.t("agentConfig.clearing") : language.t("agentConfig.clearChat")}
          </button>
          <button
            type="button"
            class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 disabled:opacity-40"
            disabled={busy() !== undefined || agent() === undefined}
            onClick={() => void clone()}
          >
            {busy() === "clone" ? language.t("agentConfig.cloning") : language.t("agentConfig.clone")}
          </button>
          <Show when={!governing()}>
            {/* ⚠️ Ordinary weight, NOT danger red, and separated from Retire — the two must not read
                as the same kind of act. Pausing is reversible and keeps everything; retiring
                archives the chats and sets the cabinet aside. */}
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
        <Show when={!governing()}>
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
                !dirty() || !reasoningBudgetValid() || saving() || props.agentID === undefined || agent() === undefined
              }
              onClick={() => void save()}
            >
              {saving() ? language.t("agentConfig.saving") : language.t("agentConfig.save")}
            </button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
