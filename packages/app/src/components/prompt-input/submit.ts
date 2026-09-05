import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@novaclaw/core/util/encode"
import { Binary } from "@novaclaw/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { OPTIMISTIC_METADATA_KEY } from "@/context/global-sync/message-v2-store"
import { kickPendingPrompts } from "@/utils/session-pending-api"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import {
  useLocal,
  type FeatureChoices,
  type PermissionMode,
  type SessionModeChoice,
  type StrictChoice,
} from "@/context/local"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import type { SessionFeatureName } from "@/utils/fs-api"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildPrompt } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { errorMessage as layoutErrorMessage } from "@/pages/layout/helpers"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

/**
 * Every per-chat Tuning switch, keyed so the COMPILER refuses an incomplete list: an eighth member
 * added to `SessionFeature.Name` (`packages/schema/src/session-feature.ts`, mirrored on the wire as
 * `SessionFeatureName`) breaks this object before it can break a user's session.
 *
 * ⚠️ It exists as a list rather than a hand-written spread per feature because the hand-written
 * version shipped WRONG. Until 2026-07-31 the create call carried only `introspection`, `quality`
 * and `affective`, so a draft that ticked *Safe mode*, *Ask before changes* or *Surgical edits* —
 * three RESTRICTIONS, i.e. switches that narrow what the agent may do — was created without them
 * and the UI reported success. That is ruling 2 (*a failed mutation never reports success*) on the
 * surface where it matters most, and `session-composer-controls.ts` has no post-create catch-up
 * loop to rescue it: its `switchFeature` call is guarded on an existing session `id`, which a draft
 * does not have.
 */
const DRAFT_FEATURES = {
  introspection: true,
  quality: true,
  affective: true,
  thinkingBudget: true,
  surgicalEdits: true,
  askBeforeChanges: true,
  safeMode: true,
  contextBudget: true,
  memory: true,
  shortChat: true,
} satisfies Record<SessionFeatureName, true>

/** The switch names a draft can stage, in one place, so no call site re-lists them. */
export const DRAFT_FEATURE_NAMES = Object.keys(DRAFT_FEATURES) as readonly SessionFeatureName[]

/** The composer's staged choices for a chat that does not exist yet. */
export type NewSessionDraft = {
  permissionMode: PermissionMode
  strict: StrictChoice | undefined
  features: FeatureChoices | undefined
  mode: SessionModeChoice | undefined
  /** WHOSE chat this will be. See `NewSessionCreateBody.agent` for why it is sent at birth. */
  agent: string | undefined
}

export type NewSessionCreateBody = Partial<Record<SessionFeatureName, boolean>> & {
  permissionMode?: PermissionMode
  strict?: StrictChoice
  type?: Exclude<SessionModeChoice, "interactive">
  /**
   * 🔴 **A chat is born OWNED** (owner, 2026-08-28: *"it should be impossible at all to happen, so
   * there should be no `New session in scratch` or other ghost generator code"*).
   *
   * This path used to create the row with no agent and adopt it on the FIRST PROMPT, via the
   * `switchAgent` call further down. That window is the ghost generator: a session created and never
   * messaged stays ownerless forever — no colleague, so no roster row, so no door back to it, sitting
   * in the shared scratch root titled "New session in scratch". It is the same class the composer's
   * own note calls *"the ghost officer … re-entering through the composer"*.
   *
   * Sending it at creation closes the window rather than narrowing it: there is no instant at which
   * the row exists without an owner. The `switchAgent` below is kept for sessions that PREDATE this
   * and genuinely have no colleague yet — it is now a repair, not the mechanism.
   */
  agent?: string
}

/**
 * Fold the composer's staged draft into the `session.create` body — the ONE place a draft choice
 * becomes a per-chat override (1K + V1-nuke slice C).
 *
 * ⚠️ A key is emitted only when the user actually took a stance. That is not a micro-optimisation,
 * it is the ECS sparse-override discipline (`todo.md` → *The ECS lens*): `undefined` means INHERIT
 * — the parent chain, then the global config block — and only a divergent value creates a row
 * value. Emitting `false` for an untouched switch would stamp a stance into every new session, and
 * for the three narrowing switches it would hand a fork of a restricted parent LESS restriction
 * than its source, which ruling 8 calls a defect rather than a preference. So: never `?? false`.
 */
export function newSessionCreateBody(draft: NewSessionDraft): NewSessionCreateBody {
  const features: Partial<Record<SessionFeatureName, boolean>> = {}
  for (const name of DRAFT_FEATURE_NAMES) {
    const stance = draft.features?.[name]
    if (stance !== undefined) features[name] = stance
  }
  return {
    // ⚠️ Emitted whenever it is KNOWN, unlike the sparse overrides around it. Those mean "inherit";
    // an absent owner means nobody, which is not a value this app is allowed to write.
    ...(draft.agent !== undefined ? { agent: draft.agent } : {}),
    ...(draft.permissionMode !== "ask" ? { permissionMode: draft.permissionMode } : {}),
    ...(draft.strict !== undefined ? { strict: draft.strict } : {}),
    ...features,
    // The composer's Mode choice becomes the session's kernel thread type at create time
    // (interactive is the server default — only an explicit unattended choice is sent).
    ...(draft.mode !== undefined && draft.mode !== "interactive" ? { type: draft.mode } : {}),
  }
}

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  client: DirectorySDK["client"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  // ⚠️ A custom-command branch stood here until 2026-09-01 (). It was unreachable: the only
  // caller, `handleSubmit`, applies the identical test against the identical store and returns before
  // ever reaching this call, so no input could arrive here naming a command. Its one piece of live
  // reasoning — refusing a command that carries attachments — was NOT deleted with it; it now sits on
  // `handleSubmit`'s command and shell branches, before `clearInput()`, where it can actually fire
  // (). `git log -S "A command with file attachments"` has the original.

  const messageID = input.messageID ?? Identifier.ascending("message")
  const prompt = buildPrompt({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionDirectory: input.draft.sessionDirectory,
  })

  setBusy()

  // Put the user's own words on screen NOW, before the worktree wait (five minutes, budgeted), before
  // any switchModel/switchAgent round-trip, and before the prompt POST. Until this, the message was
  // nowhere between Enter and the server's echo — which reads as "it disappeared", and the recovery a
  // user reaches for is retyping it. Keyed on `messageID`, the id we are about to send, so the echo
  // lands on the same row instead of beside it. `time.created` is load-bearing — see `optimistic`.
  //
  // ⚠️ SHOWING the message must never be able to stop SENDING it. Both calls are guarded because the
  // inversion is catastrophic and silent: a throw here happens BEFORE the prompt POST, so a display
  // fault would swallow the user's message entirely — the exact harm this code exists to prevent,
  // caused by the fix for it. Caught live by `submit.test.ts`, whose serverSync mock has no
  // `nativeMessages`: the assertion that failed was "the prompt reached the session", not anything
  // about rendering. Delivery is the product; the echo is a courtesy.
  // ⚠️ ONLY when the session is IDLE, and the boundary is not an optimisation — it is ownership.
  //
  // A prompt sent MID-TURN is admitted to the server's durable input queue and rendered by
  // `QueuedMessage` from `fetchPendingPrompts`, which is read from the SERVER on purpose so a prompt
  // sent from another device or the messenger gateway also appears (see session-pending-api.ts's
  // header — that is a recorded decision, not an accident). Showing an optimistic row there too would
  // put the same message on screen TWICE: once as a normal bubble, once as a queued one.
  //
  // Idle is the case nothing else covers: the pending poll does not even run (its effect returns early
  // when the session is not working and nothing is queued), so between Enter and the first
  // `session.next.prompted` there is no other view of the message at all.
  // Guarded like the calls below, and for the same reason: this runs BEFORE the prompt POST, so an
  // exception here would swallow the message. ⚠️ It fails toward SHOWING. If we cannot tell whether the
  // session was busy, a duplicate bubble is visible, self-correcting (the queued one clears on
  // promotion) and merely untidy — while a missing message is the defect being fixed. Pick the failure
  // that a user can see over the one that looks like their words were thrown away.
  const wasBusy = (() => {
    try {
      return input.sync.data.session_working(input.draft.sessionID) === true
    } catch {
      return false
    }
  })()
  const showOptimistic = () => {
    if (wasBusy) return
    try {
      input.serverSync.nativeMessages?.optimistic(input.draft.sessionID, {
        id: messageID,
        type: "user",
        text,
        time: { created: Date.now() },
        // Marks it as not-yet-acknowledged so the transcript can render it as SENDING rather than
        // sent — the owner's "unread". Cleared by the server's own echo, which replaces this row.
        metadata: { [OPTIMISTIC_METADATA_KEY]: true },
      })
    } catch {
      /* a transcript that cannot render the echo must still deliver the prompt */
    }
  }
  const forgetOptimistic = () => {
    try {
      input.serverSync.nativeMessages?.forget(input.draft.sessionID, messageID)
    } catch {
      /* nothing to take back */
    }
  }
  showOptimistic()

  try {
    if (!(await wait())) {
      setIdle()
      forgetOptimistic()
      return false
    }

    // The composer's agent/model selection persists on the session (V2 switch semantics — the V1
    // promptAsync carried them per turn). Switch only when the record disagrees.
    const record = input.serverSync.session.get(input.draft.sessionID)
    const draftModel = input.draft.model
    if (
      record?.model?.providerID !== draftModel.providerID ||
      record?.model?.id !== draftModel.modelID ||
      (input.draft.variant !== undefined && record?.model?.variant !== input.draft.variant)
    )
      await input.client.v2.session.switchModel({
        sessionID: input.draft.sessionID,
        model: {
          providerID: draftModel.providerID,
          id: draftModel.modelID,
          ...(input.draft.variant ? { variant: input.draft.variant } : {}),
        },
      })
    /**
     * 🔴 **A chat that already has a colleague is NEVER reassigned from here** (owner, 2026-08-27:
     * *"any chat with Umbris for some reason switches to a chat with Build"*).
     *
     * This line used to switch whenever the record and the draft disagreed, and the draft is a GUESS.
     * `local.tsx`'s `pickAgent` answers `items.find(name) ?? items[0]`, and `items[0]` is `build` —
     * the first row of the legacy roster projection — so any moment the session scope had not
     * resolved, or the colleague was missing from that list, the composer produced `build` and this
     * line WROTE it onto the session. Measured on the owner's instance: three chats titled "Umbris"
     * running as `build`, each stamping `agent-switched → build` on its first prompt, and a fourth
     * that ran two turns as `build` before recovering. The roster then showed no chat for Umbris
     * while the transcript the user was typing into belonged to a posture with no Contacts row —
     * the ghost officer `67a071a0d` set out to abolish, re-entering through the composer.
     *
     * ⚠️ **The session is the AUTHORITY on whose chat it is**, not the composer. `agent-option.ts`
     * already states the rule this restores: *"a chat belongs to ONE colleague … a mid-conversation
     * agent switch would hand somebody else's transcript to a different officer"*. The composer has
     * no picker in a chat, so it can never carry a deliberate switch — only an accident.
     *
     * So the switch survives for exactly the case it was written for: a session that has NO colleague
     * yet, where the draft is the only answer available. Reassignment proper has its own surface.
     */
    if (record?.agent === undefined && input.draft.agent !== undefined)
      await input.client.v2.session.switchAgent({ sessionID: input.draft.sessionID, agent: input.draft.agent })
    await input.client.v2.session.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      prompt,
    })
    // The server has it now. If this was a mid-turn prompt it is sitting in the durable input queue,
    // and the queued-bubble poll would not otherwise look for it until its next 2 s tick — so say so
    // rather than letting the user watch an empty transcript wonder whether Enter worked. Fired after
    // the POST on purpose: before it there is nothing to fetch. Idle sessions already have their row.
    if (wasBusy) kickPendingPrompts()
    return true
  } catch (err) {
    setIdle()
    // The send failed, so the row has to go. Leaving it would trade a missing message for a LYING one
    // — the user sees their prompt sitting in the transcript as though it landed, and the composer has
    // already restored the text for them to retry, so keeping it would also show the message twice.
    forgetOptimistic()
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  onAbort?: () => void
  onSubmit?: () => void
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => layoutErrorMessage(err, language.t("common.requestFailed"))

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .client.v2.session.interrupt({
        sessionID,
      })
      .catch((err) => {
        // Stop is the control a user reaches for when something is already going wrong, so a silent
        // failure here is the worst-placed one in the composer: the agent keeps streaming and the
        // UI gives no reason. Ruling 2 — a failed mutation never reports success. This was the last
        // `.catch(() => {})` in the file; every other failure path already toasts this exact shape.
        // Ported from outside contribution #10 by @DassaultFalconKing.
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const isNewSession = !params.id
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      // 1K + V1-nuke slice C: the composer's staged choices (permission mode, the Strict switch,
      // the Tuning toggles) are FIRST-CLASS fields on the native create — a draft choice becomes
      // the new session's per-chat override. `newSessionCreateBody` owns that mapping so no switch
      // can be forgotten here again; see its comment for what forgetting three of them cost.
      const created = await client.v2.session
        .create(
          newSessionCreateBody({
            permissionMode: local.permissionMode.current(),
            strict: local.strict.current(),
            features: local.features.current(),
            mode: local.mode.current(),
            // Guarded above (`if (!currentModel || !currentAgent) return`), so this is never blank.
            agent: currentAgent.name,
          }),
        )
        .then((x) => x.data?.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        const draftID = search.draftId
        if (draftID)
          tabs.promoteDraft(draftID, {
            server: tabs.draft(draftID).server,
            sessionId: session.id,
            // ⚠️ `created`, not `session`: the local is widened to `input.info()`'s `{ id }` shape,
            // so reading the colleague off it does not typecheck — and the id alone is exactly the
            // key that was never enough.
            agent: created.agent,
          })
        else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
        submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    input.onSubmit?.()

    if (mode === "shell") {
      // 🔴 BEFORE `clearInput()`, which runs `target.reset()` and wipes the image parts. Neither
      // `shell` nor `command` carries an attachment field, so without this the request succeeds, the
      // thumbnail vanishes from the tray, and nothing is said — ruling 2, a loss reported as success.
      // Refusing without clearing leaves the text AND the attachment in place, so the user can drop
      // the image or send it as an ordinary message. ()
      if (images.length > 0) {
        showToast({
          title: language.t("prompt.toast.attachmentsUnsupportedHere.title"),
          description: language.t("prompt.toast.attachmentsUnsupportedHere.description"),
        })
        return
      }
      clearInput()
      client.v2.session
        .shell({
          sessionID: session.id,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        // Same refusal as the shell branch above, and for the same reason — see there. ()
        if (images.length > 0) {
          showToast({
            title: language.t("prompt.toast.attachmentsUnsupportedHere.title"),
            description: language.t("prompt.toast.attachmentsUnsupportedHere.description"),
          })
          return
        }
        clearInput()
        client.v2.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
