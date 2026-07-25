import { useFilteredList } from "@novaclaw/ui/hooks"
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
  Switch,
  Match,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionMode, useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useComments } from "@/context/comments"
import { Button } from "@novaclaw/ui/button"
import { DockShellForm, DockTray } from "@novaclaw/ui/dock-surface"
import { Icon } from "@novaclaw/ui/icon"
import { Tooltip, TooltipKeybind } from "@novaclaw/ui/tooltip"
import { KeybindV2 } from "@novaclaw/ui/v2/keybind-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { IconButton } from "@novaclaw/ui/icon-button"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useCommand } from "@/context/command"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"
import {
  ComposerAttachmentsTray,
  ComposerControlsRow,
  ComposerEditorSurface,
  ComposerLegacyModelControls,
  ComposerVariantControl,
  type ComposerAttachmentsTrayState,
  type ComposerFeaturesControlState,
  type ComposerFolderControlState,
  type ComposerModelControlState,
  type ComposerPermissionModeControlState,
  type ComposerRemoteChatState,
  type ComposerStrictControlState,
} from "@/components/composer"
import { usePlatform } from "@/context/platform"
import { createSessionTabs } from "@/pages/session/helpers"
import { getCursorPosition } from "./prompt-input/editor-dom"
import { createEditorCore } from "./prompt-input/editor-core"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES, pickAttachmentFiles } from "./prompt-input/files"
import {
  canNavigateHistoryAtCursor,
  createPersistedPromptInputHistory,
  navigatePromptHistory,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptInputHistory,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit, type FollowupDraft } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { promptPlaceholder, PROMPT_EXAMPLE_KEYS } from "./prompt-input/placeholder"
import { composerMounts } from "./prompt-input/mount-registry"
import { createPromptInputTransientState } from "./prompt-input/transient-state"
import { showToast } from "@/utils/toast"

export type PromptInputState = ReturnType<typeof usePrompt>

export { createPromptInputHistory } from "./prompt-input/history"
export type { PromptInputHistory }

export type PromptInputSubmission = {
  abort: () => Promise<void> | void
  handleSubmit: (event: Event) => Promise<void> | void
}

export type PromptInputControls = {
  // The visible agent picker (plan/build) was opencode residue and is gone — the permission-mode
  // droplist is the one mode control. `available` stays: it feeds the @-mention subagent list.
  agents: {
    available: { name: string; hidden?: boolean; mode: string }[]
  }
  model: {
    selection: ReturnType<typeof useLocal>["model"]
    paid: boolean
    loading: boolean
  }
  // 1K: the create-time permission-mode droplist (only rendered on the new-session composer).
  permissionMode: {
    current: PermissionMode
    select: (value: PermissionMode) => void
  }
  // The chat's working folder (mid-session only): shows where the agent works; picking a new
  // folder MIGRATES the session there (control-plane move). Disabled while the agent is working.
  folder: {
    name: string
    visible: boolean
    working: boolean
    pick: () => void
  }
  // The per-chat Tuning toggles: current = the EFFECTIVE stance per feature (draft → session
  // record → global config); set writes this chat's explicit stance (and persists it live).
  features: {
    current: Record<"introspection" | "quality" | "affective" | "thinkingBudget" | "surgicalEdits" | "askBeforeChanges", boolean>
    set: (feature: "introspection" | "quality" | "affective" | "thinkingBudget" | "surgicalEdits" | "askBeforeChanges", enabled: boolean) => void
  }
  // The per-chat Mode control (kernel thread type): interactive, or the unattended pair
  // (auto-prompting · goal-oriented — asks auto-allow, bash confined by the Agent Jail).
  mode: {
    current: "interactive" | "auto-prompting" | "goal-oriented"
    set: (value: "interactive" | "auto-prompting" | "goal-oriented") => void
  }
  // The Remote-chat control (messenger-plan §6.2): which messenger chat this session lives in
  // remotely — accounts, this session's binding, and the connect/disconnect actions.
  remote: ComposerRemoteChatState
  // The per-chat Strict-harness switch (jh.md): current = the effective state (session override →
  // draft → global Settings default); set writes the per-session override (and stages it on drafts).
  strict: {
    current: { enabled?: boolean; attempts?: number; wallMinutes?: number }
    set: (value: { enabled: boolean; attempts?: number; wallMinutes?: number }) => void
  }
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
  newLayoutDesigns: boolean
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
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  toolbar?: JSX.Element
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()

  const sync = useSync()
  const serverSync = useServerSync()
  const files = useFile()
  const prompt = props.state ?? usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
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
        <Icon name="enter" size="small" class="text-icon-base" />
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
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editor.focusAt(length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

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

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

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

  const agentList = createMemo(() =>
    props.controls.agents.available
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...agents, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    skipFilter: (item) => item.type === "file" && !item.recent,
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync().data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()
    const images = imageAttachments()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      editor.setText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      focusEditorEnd()
      return
    }

    editor.clear()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const scrollSlashActiveIntoView = () => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  }
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (editor.isNormalized()) return

      editor.renderWithCursor(input)
      return
    }

    const dom = editor.parse()
    if (editor.isNormalized() && isPromptEqual(input, dom)) return

    editor.renderWithCursor(input)
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

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    history.add(prompt, mode, mode === "shell" ? [] : historyComments())
  }

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

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: history.entries(store.mode),
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

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
  const accepting = createMemo(() => {
    const id = props.controls.session.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk().directory)
    return permission.isAutoAccepting(id, sdk().directory)
  })

  const { abort, handleSubmit } =
    props.submission ??
    createPromptSubmit({
      prompt,
      info,
      imageAttachments,
      commentCount,
      autoAccept: () => accepting(),
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
      shouldQueue: props.shouldQueue,
      onQueue: props.onQueue,
      onAbort: props.onAbort,
      onSubmit: props.onSubmit,
    })

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      editor.collapseBackspaceAtZeroWidth()
    }

    // uix.md §6.4: for a Normal user a leading "!" just types "!" — the accidental keystroke must not
    // flip the friendly chat box into a terminal. Shell mode is an Advanced+ affordance.
    if (event.key === "!" && store.mode === "normal" && expertise.atLeast("advanced")) {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        void abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
          if (event.key === "ArrowUp" || event.key === "ArrowDown" || ctrlNav) {
            scrollSlashActiveIntoView()
          }
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (
        working() &&
        prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join("")
          .trim().length === 0 &&
        imageAttachments().length === 0 &&
        commentCount() === 0
      ) {
        return
      }
      void handleSubmit(event)
    }
  }

  const providersLoading = () => props.controls.model.loading
  const providersShouldFadeIn = createMemo<boolean>((prev) => prev ?? providersLoading())

  const [promptReady] = createResource(
    () => prompt.ready.promise,
    (p) => p,
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

  const modelControlState = createMemo<ComposerModelControlState>(() => ({
    loading: providersLoading(),
    shouldAnimate: providersShouldFadeIn(),
    title: language.t("command.model.choose"),
    keybind: command.keybindParts("model.choose"),
    model: props.controls.model.selection,
    providerID: props.controls.model.selection.current()?.provider?.id,
    modelName: props.controls.model.selection.current()?.name ?? language.t("dialog.model.select.title"),
    style: control(),
    onClose: restoreFocus,
  }))

  const newSession = () => props.variant === "new-session"
  const permissionModeControlState = createMemo<ComposerPermissionModeControlState>(() => ({
    title: language.t("prompt.permissionMode.title"),
    current: props.controls.permissionMode.current,
    label: (mode) => language.t(`prompt.permissionMode.${mode}` as Parameters<typeof language.t>[0]),
    style: control(),
    onSelect: (value) => {
      props.controls.permissionMode.select(value)
      restoreFocus()
    },
  }))
  const strictControlState = createMemo<ComposerStrictControlState>(() => ({
    current: props.controls.strict.current,
    permissionBelowFloor:
      props.controls.permissionMode.current !== "bypass" && props.controls.permissionMode.current !== "yolo",
    style: control(),
    set: (value) => props.controls.strict.set(value),
    onClose: restoreFocus,
  }))
  const featuresControlState = createMemo<ComposerFeaturesControlState>(() => ({
    current: props.controls.features.current,
    mode: props.controls.mode.current,
    remote: props.controls.remote,
    style: control(),
    set: (feature, enabled) => props.controls.features.set(feature, enabled),
    setMode: (value) => props.controls.mode.set(value),
    onClose: restoreFocus,
  }))
  const folderControlState = createMemo<ComposerFolderControlState>(() => ({
    name: props.controls.folder.name,
    working: props.controls.folder.working,
    style: control(),
    pick: () => props.controls.folder.pick(),
  }))
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
      {(promptReady(), null)}
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        commandKeybindParts={command.keybindParts}
        newLayoutDesigns={props.controls.newLayoutDesigns}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <Switch>
        <Match when={props.controls.newLayoutDesigns}>
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
                    <IconButton
                      data-action="prompt-submit"
                      type="submit"
                      disabled={!working() && blank()}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                      variant="primary"
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
                        <KeybindV2 keys={command.keybindParts("file.attach")} variant="neutral" />
                      </>
                    }
                  >
                    <IconButton
                      data-action="prompt-attach"
                      type="button"
                      icon="plus"
                      variant="ghost"
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
                      folderVisible: props.controls.folder.visible,
                      model: modelControlState(),
                      permissionMode: permissionModeControlState(),
                      strict: strictControlState(),
                      features: featuresControlState(),
                      folder: folderControlState(),
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
        </Match>
        <Match when>
          <DockShellForm
            onSubmit={handleSubmit}
            classList={{
              "group/prompt-input": true,
              "focus-within:shadow-xs-border": true,
              "border-icon-info-active border-dashed": store.draggingType !== null,
              [props.class ?? ""]: !!props.class,
            }}
          >
            <ComposerAttachmentsTray state={attachmentsTrayState()} />
            <div
              class="relative"
              onMouseDown={(e) => {
                const target = e.target
                if (!(target instanceof HTMLElement)) return
                if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) {
                  return
                }
                editorRef?.focus()
              }}
            >
              <ComposerEditorSurface
                state={{
                  mode: store.mode,
                  ariaLabel: placeholder(),
                  placeholder: placeholder(),
                  dirty: prompt.dirty(),
                  scrollClass: "relative max-h-[240px] overflow-y-auto no-scrollbar",
                  scrollStyle: { "scroll-padding-bottom": space },
                  editorClass:
                    "w-full pl-3 pr-2 pt-2 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap",
                  editorStyle: { "padding-bottom": space },
                  placeholderClass:
                    "absolute top-0 inset-x-0 pl-3 pr-2 pt-2 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate",
                  placeholderStyle: { "padding-bottom": space },
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

              <div
                aria-hidden="true"
                class="pointer-events-none absolute inset-x-0 bottom-0"
                style={{
                  height: space,
                  background:
                    "linear-gradient(to top, var(--surface-raised-stronger-non-alpha) calc(100% - 20px), transparent)",
                }}
              />

              <div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2">
                <input
                  ref={fileInputRef}
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

                <div class="flex items-center gap-1 pointer-events-auto">
                  <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
                    <IconButton
                      data-action="prompt-submit"
                      type="submit"
                      disabled={!working() && blank()}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                      variant="primary"
                      class="size-8"
                      aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                    />
                  </Tooltip>
                </div>
              </div>

              <div class="pointer-events-none absolute bottom-2 left-2">
                <div
                  aria-hidden={store.mode !== "normal"}
                  class="pointer-events-auto"
                  style={{
                    "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                  }}
                >
                  <TooltipKeybind
                    placement="top"
                    title={language.t("prompt.action.attachFile")}
                    keybind={command.keybind("file.attach")}
                  >
                    <Button
                      data-action="prompt-attach"
                      type="button"
                      variant="ghost"
                      class="size-8 p-0"
                      style={buttons()}
                      onClick={pick}
                      disabled={store.mode !== "normal"}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      aria-label={language.t("prompt.action.attachFile")}
                    >
                      <Icon name="plus" class="size-4.5" />
                    </Button>
                  </TooltipKeybind>
                </div>
              </div>
            </div>
          </DockShellForm>
          <Show when={store.mode === "normal" || store.mode === "shell"}>
            <DockTray attach="top">
              <div class="px-1.75 pt-5.5 pb-2 flex items-center gap-2 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0 flex-1 relative">
                  <div
                    class="h-7 flex items-center gap-1.5 min-w-0 absolute inset-0"
                    style={{
                      padding: "0 0px 0 8px",
                      ...shell(),
                    }}
                  >
                    <Icon name="console" />
                    <span class="truncate text-13-medium text-text-base">{language.t("prompt.mode.shell")}</span>
                    <div class="flex-1" />
                    <Button
                      variant="ghost"
                      class="text-text-base"
                      onClick={() => {
                        setStore("mode", "normal")
                      }}
                    >
                      {language.t("common.cancel")}
                    </Button>
                  </div>
                  <div class="flex items-center gap-1.5 min-w-0 flex-1 h-7">
                    <Show when={!providersLoading()}>
                      <Show when={store.mode !== "shell"}>
                        <ComposerLegacyModelControls
                          state={{
                            model: props.controls.model.selection,
                            shouldAnimate: providersShouldFadeIn(),
                            showVariant: showVariantControl(),
                            variants: variants(),
                            style: control(),
                            onDone: restoreFocus,
                          }}
                        />
                      </Show>
                    </Show>
                  </div>
                </div>
              </div>
            </DockTray>
          </Show>
        </Match>
      </Switch>
    </div>
  )
}
