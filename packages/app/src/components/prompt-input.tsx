import { useSpring } from "@novaclaw/ui/motion-spring"
import {
  createEffect,
  on,
  Component,
  Show,
  onCleanup,
  createMemo,
  createSignal,
  createResource,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import { ContentPart, DEFAULT_PROMPT, isPromptEqual, Prompt, usePrompt, ImageAttachmentPart } from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useComments } from "@/context/comments"
import { DockShellForm, DockTray } from "@novaclaw/ui/dock-surface"
import { Icon } from "@novaclaw/ui/v2/icon"
import { KeybindV2 } from "@novaclaw/ui/v2/keybind-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"
import {
  ComposerAttachmentsTray,
  ComposerControlsRow,
  ComposerEditorSurface,
  ComposerVariantControl,
  type ComposerAttachmentsTrayState,
  type ComposerFeaturesControlState,
  type ComposerAgentControlState,
  type ComposerAgentOption,
  type ComposerRemoteChatState,
} from "@/components/composer"
import { usePlatform } from "@/context/platform"
import { createSessionTabs } from "@/pages/session/helpers"
import { getCursorPosition } from "./prompt-input/editor-dom"
import { createEditorCore } from "./prompt-input/editor-core"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES, pickAttachmentFiles } from "./prompt-input/files"
import { createPersistedPromptInputHistory, type PromptInputHistory, promptLength } from "./prompt-input/history"
import { createPromptInputHistoryController } from "./prompt-input/history-controller"
import { createPromptInputKeyboardController } from "./prompt-input/keyboard-controller"
import { createPromptInputPopoverController } from "./prompt-input/popover-controller"
import { atOptionKey } from "./prompt-input/popover-options"
import { createPromptSubmit, type FollowupDraft } from "./prompt-input/submit"
import { PromptPopover } from "./prompt-input/slash-popover"
import { promptPlaceholder, PROMPT_EXAMPLE_KEYS } from "./prompt-input/placeholder"
import { composerMounts } from "./prompt-input/mount-registry"
import { createPromptInputTransientState } from "./prompt-input/transient-state"
import { showToast } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { reconnectingPromptAttempt } from "./prompt-input/connection-state"
import { PromptConnectionBoundary } from "./prompt-input/connection-notice"

export type PromptInputState = ReturnType<typeof usePrompt>

export { createPromptInputHistory } from "./prompt-input/history"
export type { PromptInputHistory }

export type PromptInputSubmission = {
  abort: () => Promise<void> | void
  handleSubmit: (event: Event) => Promise<void> | void
}

export type PromptInputControls = {
  // The visible agent picker (plan/build) was predecessor residue and is gone — the permission-mode
  // droplist is the one mode control. `available` stays: it feeds the @-mention subagent list.
  agents: {
    available: { name: string; hidden?: boolean; mode: string }[]
    /** WHO this chat is talking to. Tune opens this colleague's config (AGENTS.md — the structural
     *  metaphor), so it is the composer's business now, not only the runner's. */
    current: string | undefined
  }
  model: {
    selection: ReturnType<typeof useLocal>["model"]
    loading: boolean
  }
  // WHOSE chat this is (mid-session only). Replaced the folder chip on 2026-08-21: a chat's folder
  // is its COLLEAGUE's folder now, so a per-chat move would leave the two disagreeing. Identity, not
  // a picker — see `agent-option.ts`.
  agent: {
    visible: boolean
    option: ComposerAgentOption | undefined
  }
  // The per-chat Tuning toggles: current = the EFFECTIVE stance per feature (draft → session
  // record → global config); set writes this chat's explicit stance (and persists it live).
  // ⚠️ A `Pick` of `ComposerFeaturesControlState`, not a hand-written copy of it. This was an inline
  // `Record<"introspection" | … | "askBeforeChanges", boolean>` plus a matching `set` signature — a
  // second spelling of a union this file ALREADY imports, which meant every new switch had to be
  // added here too or the build broke in a place that reads nothing like the change. Adding
  // `safeMode` (2026-07-31) is what surfaced it.
  // ⚠️ `Pick`, and not the whole state, because the two are NOT the same type: the control's state
  // also carries `mode`/`remote`/`style`/`setMode`/`onClose`, which this prop deliberately does not
  // require. Widening it to the full state was tried and is a compile error at the one call site that
  // builds this object — the narrowness is load-bearing, only the duplicated key union was not.
  features: Pick<
    ComposerFeaturesControlState,
    "current" | "override" | "origin" | "project" | "makeDefault" | "set" | "inherit"
  >

  // The per-chat Mode control (kernel thread type): interactive, or the unattended pair
  // (auto-prompting · goal-oriented — asks auto-allow, bash confined by the Agent Jail).
  mode: {
    current: "interactive" | "auto-prompting" | "goal-oriented"
    set: (value: "interactive" | "auto-prompting" | "goal-oriented") => void
  }
  // The Remote-chat control (messenger-plan §6.2): which messenger chat this session lives in
  // remotely — accounts, this session's binding, and the connect/disconnect actions.
  remote: ComposerRemoteChatState
  // ⚠️ No `permissionMode`, `strict` or `model.paid` here (2026-09-03): the controls that read them
  // were deleted earlier in the sweep and the fields outlived them — the producer did real work (an
  // optimistic write, a permission-mode escalation) to fill props nothing rendered. The composer's
  // own permission mode and Strict state are read from `local` by `prompt-input/submit.ts`.
  session: {
    id?: string
    tabs: {
      active: () => string | undefined
      all: () => string[]
      open: (tab: string) => void | Promise<void>
      setActive: (tab: string) => void
    }
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
}

export interface PromptInputProps {
  class?: string
  variant?: "dock" | "new-session"
  state?: PromptInputState
  history?: PromptInputHistory
  submission?: PromptInputSubmission
  controls: PromptInputControls
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  onAbort?: () => void
  onSubmit?: () => void
  toolbar?: JSX.Element
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  const sync = useSync()
  const serverSync = useServerSync()
  const files = useFile()
  const prompt = props.state ?? usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const expertise = useExpertise()
  const tabs = () => props.controls.session.tabs
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }
  const inset = 56
  const space = `${inset}px`

  // P4a editor-core: all contenteditable Range/Selection surgery lives behind this facade.
  const editor = createEditorCore({ editor: () => editorRef, empty: () => DEFAULT_PROMPT })

  const scrollCursorIntoView = () =>
    editor.scrollCursorIntoView(scrollRef, {
      inset,
      contentLength: promptLength(prompt.current().filter((part) => part.type !== "image")),
    })

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false

    const diffs = sync().data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (props.controls.session.id ? sync().session.get(props.controls.session.id) : undefined))
  const working = createMemo(() => sync().data.session_working(props.controls.session.id ?? ""))
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createPromptInputTransientState(
    () => prompt.capture(),
    Math.floor(Math.random() * PROMPT_EXAMPLE_KEYS.length),
  )
  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" size="normal" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false
    const messages = serverSync().nativeMessages.messages(sessionID)
    if (!messages) return false
    return messages.some((m) => m.type === "user")
  })

  const history = props.history ?? createPersistedPromptInputHistory()

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest()
        ? store.mode === "shell"
          ? "git status"
          : language.t(PROMPT_EXAMPLE_KEYS[store.placeholder])
        : "",
      suggest: suggest(),
      t: language.t,
    }),
  )

  const historyController = createPromptInputHistoryController({
    history,
    comments,
    prompt,
    editor,
    store,
    setStore,
    queueScroll,
  })
  const historyComments = historyController.comments

  const getCaretState = () => editor.caretState(promptLength(prompt.current()))

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => {
    pickAttachmentFiles({
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      fallback: () => fileInputRef?.click(),
      onFile: addAttachment,
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
    })
  }

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      // Shell mode is Advanced+ (uix.md §6.4) — disabled at Normal so the keybind is inert too.
      disabled: store.mode === "shell" || !expertise.atLeast("advanced"),
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
  ])

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = historyController.reset

  const focusEditorEnd = () => {
    requestAnimationFrame(() => editor.placeCursorAtEnd())
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editor.focusAt(cursor)
      queueScroll()
    })
  }

  createEffect(() => {
    props.controls.session.id
    if (props.controls.session.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % PROMPT_EXAMPLE_KEYS.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  const popoverController = createPromptInputPopoverController({
    agents: () => props.controls.agents.available,
    recent,
    searchFiles: files.searchFilesAndDirectories,
    customCommands: () => sync().data.command,
    builtinCommands: () => command.options,
    triggerCommand: (id) => command.trigger(id, "slash"),
    popover: () => store.popover,
    slashPopover: () => slashPopoverRef,
    imageAttachments,
    addPart: (part) => addPart(part),
    close: closePopover,
    editor,
    prompt,
    focusEnd: focusEditorEnd,
  })
  const {
    at: {
      flat: atFlat,
      error: atError,
      refetch: retryAt,
      active: atActive,
      setActive: setAtActive,
      onInput: atOnInput,
      onKeyDown: atOnKeyDown,
    },
    slash: {
      flat: slashFlat,
      active: slashActive,
      setActive: setSlashActive,
      onInput: slashOnInput,
      onKeyDown: slashOnKeyDown,
    },
    selectAt: handleAtSelect,
    selectSlash: handleSlashSelect,
    selectActive: selectPopoverActive,
    scrollSlashActiveIntoView,
  } = popoverController

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (editor.isNormalized()) return

      editor.renderWithCursor(input, prompt.cursor())
      return
    }

    const dom = editor.parse()
    if (editor.isNormalized() && isPromptEqual(input, dom)) return

    editor.renderWithCursor(input, prompt.cursor())
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const handleInput = () => {
    const rawParts = editor.parse()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const textContent = (editorRef.textContent ?? "").replace(/\u200B/g, "")
    const shouldReset =
      textContent.length === 0 && rawText.replace(/\n/g, "").length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    const inserted = editor.insertPart(part, {
      fallbackCursor: () => prompt.cursor() ?? promptLength(prompt.current()),
      text: () =>
        prompt
          .current()
          .map((p) => ("content" in p ? p.content : ""))
          .join(""),
    })
    if (!inserted) return false

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = historyController.add

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          editor.focusAt(promptLength(edit.prompt))
          queueScroll()
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  const navigateHistory = historyController.navigate

  const { addAttachment, addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    prompt,
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => editor.focusAt(promptLength(prompt.current())),
    addPart,
    readClipboardImage: platform.readClipboardImage,
    getPathForFile: platform.getPathForFile,
  })

  const fileAttachmentInput = () => (
    <input
      ref={(el) => (fileInputRef = el)}
      type="file"
      multiple
      accept={ACCEPTED_FILE_TYPES.join(",")}
      class="hidden"
      onChange={(e) => {
        const list = e.currentTarget.files
        if (list) void addAttachments(Array.from(list))
        e.currentTarget.value = ""
      }}
    />
  )

  const variants = createMemo(() => ["default", ...props.controls.model.selection.variant.list()])
  // Check provider variants directly: `variants` also includes the UI-only default option.
  const showVariantControl = createMemo(() => props.controls.model.selection.variant.list().length > 0)
  const { abort, handleSubmit } =
    props.submission ??
    createPromptSubmit({
      prompt,
      info,
      imageAttachments,
      commentCount,
      mode: () => store.mode,
      working,
      editor: () => editorRef,
      queueScroll,
      promptLength,
      addToHistory,
      resetHistoryNavigation: () => {
        resetHistoryNavigation(true)
      },
      setMode: (mode) => setStore("mode", mode),
      setPopover: (popover) => setStore("popover", popover),
      newSessionWorktree: () => props.newSessionWorktree,
      onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
      onAbort: props.onAbort,
      onSubmit: props.onSubmit,
    })

  const promptText = () =>
    prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")

  const handleKeyDown = createPromptInputKeyboardController({
    state: {
      mode: () => store.mode,
      popover: () => store.popover,
      historyIndex: () => store.historyIndex,
    },
    editor: {
      element: () => editorRef,
      collapseBackspaceAtZeroWidth: editor.collapseBackspaceAtZeroWidth,
      blur: () => editorRef.blur(),
      caret: getCaretState,
    },
    advanced: () => expertise.atLeast("advanced"),
    composing: isImeComposing,
    working,
    promptText,
    attachmentCount: () => imageAttachments().length,
    commentCount,
    setMode: (mode) => setStore("mode", mode),
    closePopover,
    pickAttachment: pick,
    abort,
    blurOnEscape: escBlur,
    addNewline: () => addPart({ type: "text", content: "\n", start: 0, end: 0 }),
    selectPopoverActive,
    atKeyDown: atOnKeyDown,
    slashKeyDown: slashOnKeyDown,
    scrollSlashActiveIntoView,
    navigateHistory,
    submit: handleSubmit,
  })

  const providersLoading = () => props.controls.model.loading
  const providersShouldFadeIn = createMemo<boolean>((prev) => prev ?? providersLoading())

  /**
   * Whether the persisted draft for this chat LOADED.
   *
   * Two jobs, and the second is why this is still a plain `createResource`: reading it below is
   * what enrols the composer in the layout's `Suspense`, so the chat does not paint an empty
   * message box that the restored draft then overwrites under the user's cursor. A
   * `createSettledResource` cannot do that — it never reads the underlying accessor in the pending
   * state, which is precisely the read `Suspense` counts.
   *
   * 🔴 It is nonetheless safe now, and not because of anything written here. `ready.promise` used
   * to REJECT on a failed persisted read, which errored this resource, and Solid's accessor
   * re-throws from an error stored that way — from a bare comma-expression in JSX, outside any
   * local `ErrorBoundary`, so a single failed `store-set` replaced the whole application with the
   * fatal error page. That is closed at its source in `utils/persist.ts`: the promise resolves
   * `false` instead of rejecting, and `ready()` cannot throw either. Here the `false` is a value
   * like any other, and the composer says so rather than pretending it restored a draft it never
   * read.
   */
  const [promptReady] = createResource(
    () => prompt.ready.promise,
    async (promise) => (await promise) === true,
  )

  // P3 one-view-host invariant: every live composer registers per session so a steady-state
  // duplicate (a second mounter outside the router) warns the moment it regresses.
  createEffect(() => {
    const release = composerMounts.register(props.controls.session.id ?? "draft")
    onCleanup(release)
  })

  // Focus the message box as soon as a chat opens (owner call 2026-07-14: click-to-create must
  // land the user READY TO TYPE). Once per mount, after the persisted draft loads (so the cursor
  // goes to the end of any restored text) — unless the user already put focus somewhere real
  // (typing in another field must not be hijacked by a background load settling).
  // Synchronous on purpose (no rAF): a backgrounded window never fires animation frames, and a
  // parked focus would then pop in whenever the window resurfaces, stealing whatever the user
  // was doing by that point. One shot, no retry: session views mount through the router only
  // (P3), so the composer is never reparented out from under a just-placed focus anymore.
  let autoFocused = false
  createEffect(() => {
    if (autoFocused || !prompt.ready()) return
    autoFocused = true
    const active = document.activeElement
    const idle = !active || active === document.body || !(active instanceof HTMLElement) || active.tagName === "BUTTON"
    if (!idle) return // the user focused something real — don't hijack it
    if (editorRef?.isConnected) editor.placeCursorAtEnd()
  })

  const designPlaceholder = () => {
    if (store.mode === "shell") return placeholder()
    return "Ask anything, / for commands, @ for context..."
  }

  const newSession = () => props.variant === "new-session"
  const featuresControlState = createMemo<ComposerFeaturesControlState>(() => ({
    current: props.controls.features.current,
    override: props.controls.features.override,
    origin: props.controls.features.origin,
    project: props.controls.features.project,
    makeDefault: props.controls.features.makeDefault,
    mode: props.controls.mode.current,
    agent: props.controls.agents.current,
    remote: props.controls.remote,
    style: control(),
    set: (feature, enabled) => props.controls.features.set(feature, enabled),
    inherit: (feature) => props.controls.features.inherit(feature),
    setMode: (value) => props.controls.mode.set(value),
    onClose: restoreFocus,
  }))
  const agentControlState = createMemo<ComposerAgentControlState>(() => {
    const option = props.controls.agent.option
    return {
      options: option ? [option] : [],
      selectedID: option?.id,
      working: false,
      readOnly: true,
      onSelect: () => {},
    }
  })
  const reconnectingAttempt = createMemo(() => {
    const connection = serverSDK()
    return reconnectingPromptAttempt(connection.streamStatus(), connection.reconnectAttempt())
  })
  const attachmentsTrayState = createMemo<ComposerAttachmentsTrayState>(() => ({
    dragging: store.draggingType,
    contextItems: contextItems(),
    isContextItemActive: (item) => {
      const active = comments.active()
      return !!item.commentID && item.commentID === active?.id && item.path === active?.file
    },
    openComment,
    removeContextItem: (item) => {
      if (item.commentID) comments.remove(item.path, item.commentID)
      prompt.context.remove(item.key)
    },
    images: imageAttachments(),
    removeImage: removeAttachment,
  }))
  return (
    <div class="relative size-full flex flex-col gap-0">
      <PromptConnectionBoundary
        attempt={reconnectingAttempt()}
        text={(attempt) => language.t("app.connection.promptReconnecting", { attempt })}
      >
        {/* The bare read is the Suspense enrolment — see the resource above. It stays a statement so
            the notice below is free to be a `Show`, which is a different (memoised) read. */}
        {(promptReady(), null)}
        <Show when={promptReady() === false}>
          <div
            data-slot="prompt-draft-unavailable"
            role="status"
            class="px-1 pb-1.5 text-[12px] leading-4 text-v2-text-text-faint"
          >
            {language.t("prompt.draft.unavailable")}
          </div>
        </Show>
        <PromptPopover
          popover={store.popover}
          setSlashPopoverRef={(el) => (slashPopoverRef = el)}
          atFlat={atFlat()}
          atError={atError()}
          onAtRetry={() => void retryAt()}
          atActive={atActive() ?? undefined}
          atKey={atOptionKey}
          setAtActive={setAtActive}
          onAtSelect={handleAtSelect}
          slashFlat={slashFlat()}
          slashActive={slashActive() ?? undefined}
          setSlashActive={setSlashActive}
          onSlashSelect={handleSlashSelect}
          commandKeybindParts={command.keybindParts}
          t={language.t}
        />
        <div class="flex flex-col gap-3">
          <DockShellForm
            data-component={newSession() ? "session-new-composer" : "session-composer"}
            onSubmit={handleSubmit}
            classList={{
              "group/prompt-input min-h-[96px] w-full rounded-xl bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": true,
              "border-icon-info-active border-dashed": store.draggingType !== null,
              [props.class ?? ""]: !!props.class,
            }}
          >
            <ComposerAttachmentsTray state={attachmentsTrayState()} />
            <div class="flex items-end">
              <div
                class="relative min-h-[52px] min-w-0 flex-1"
                onMouseDown={(e) => {
                  const target = e.target
                  if (!(target instanceof HTMLElement)) return
                  if (target.closest('[data-action^="prompt-"]')) return
                  editorRef?.focus()
                }}
              >
                <ComposerEditorSurface
                  state={{
                    mode: store.mode,
                    ariaLabel: designPlaceholder(),
                    placeholder: designPlaceholder(),
                    placeholderComponent: newSession() ? "session-new-design-text" : "session-composer-text",
                    dirty: prompt.dirty(),
                    scrollClass: "relative max-h-[180px] overflow-y-auto no-scrollbar",
                    editorClass:
                      "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-[13px] font-[440] text-v2-text-text-base",
                    placeholderClass:
                      "absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]",
                    setScrollRef: (el) => (scrollRef = el),
                    setEditorRef: (el) => {
                      editorRef = el
                      props.ref?.(el)
                    },
                    onInput: handleInput,
                    onPaste: handlePaste,
                    onCompositionStart: handleCompositionStart,
                    onCompositionEnd: handleCompositionEnd,
                    onBlur: handleBlur,
                    onKeyDown: handleKeyDown,
                  }}
                />
              </div>
              {/* Send/Stop sits beside the editor (Claude Code / ChatGPT style) instead of on the
                controls row, so the pickers below own the full width and never collide with it
                on narrow / phone widths. */}
              <div class="shrink-0 self-end p-2">
                <TooltipV2 placement="top" inactive={!working() && blank()} value={tip()}>
                  <IconButtonV2
                    data-action="prompt-submit"
                    type="submit"
                    disabled={!working() && blank()}
                    tabIndex={store.mode === "normal" ? undefined : -1}
                    icon={
                      <IconV2 name={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"} />
                    }
                    variant="contrast"
                    class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
                    style={{
                      "background-image":
                        "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
                    }}
                    aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                  />
                </TooltipV2>
              </div>
            </div>
            {/* The composer controls WRAP to a second line rather than overflow or get clipped when
              the chat pane is narrow (phone) — every chip stays visible, none is cut by the
              right edge. Each control keeps its own width ([&>*]:shrink-0) so it wraps whole. */}
            <div class="flex min-h-11 flex-wrap items-center gap-y-1 px-2 py-1 [&>*]:shrink-0">
              {fileAttachmentInput()}
              <TooltipV2
                placement="top"
                value={
                  <>
                    {language.t("prompt.action.attachFile")}
                    <span class="text-v2-text-text-faint"> · {language.t("prompt.action.attachFile.scope")}</span>
                    <KeybindV2 keys={command.keybindParts("file.attach")} variant="neutral" />
                  </>
                }
              >
                <IconButtonV2
                  data-action="prompt-attach"
                  type="button"
                  icon={<IconV2 name="plus" />}
                  variant="ghost-muted"
                  class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted"
                  style={buttons()}
                  onClick={pick}
                  disabled={store.mode !== "normal"}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  aria-label={language.t("prompt.action.attachFile")}
                />
              </TooltipV2>
              {props.toolbar}
              <ComposerControlsRow
                state={{
                  sessionControls: newSession() || !!props.controls.session?.id,
                  agentVisible: props.controls.agent.visible,
                  features: featuresControlState(),
                  agent: agentControlState(),
                }}
              />
              <Show when={!providersLoading() && store.mode !== "shell" && showVariantControl()}>
                <ComposerVariantControl
                  state={{
                    revealOnHoverOnly: !props.controls.model.selection.variant.current() && !store.variantOpen,
                    shouldAnimate: providersShouldFadeIn(),
                    variants: variants(),
                    current: props.controls.model.selection.variant.current(),
                    style: control(),
                    set: (variant) => {
                      props.controls.model.selection.variant.set(variant)
                      restoreFocus()
                    },
                    onOpenChange: (open) => setStore("variantOpen", open),
                  }}
                />
              </Show>
              {/* The context gauge (owner 2026-07-22): a Claude Code-style pie showing how full
                  the model's context window is — colored amber/red as it fills so context
                  trouble is visible BEFORE it bites. Session-scoped (drafts have no context
                  yet); clicking opens the session's Context tab. Lives on the controls row with
                  the other chips (the submit button moved up beside the editor, 2026-07-24). */}
              <Show when={props.controls.session?.id}>
                <SessionContextUsage buttonAppearance="v2" placement="top" />
              </Show>
            </div>
          </DockShellForm>
        </div>
      </PromptConnectionBoundary>
    </div>
  )
}
