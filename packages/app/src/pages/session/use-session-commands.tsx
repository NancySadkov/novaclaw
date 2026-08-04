import { useNavigate } from "@solidjs/router"
import { useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { previewSelectedLines } from "@novaclaw/session-ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePrompt } from "@/context/prompt"
import { useServerSync } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { showToast } from "@/utils/toast"
import { createSessionTabs } from "@/pages/session/helpers"
import { nextMessageID, selectVisibleMessages, undoTargetID } from "@/pages/session/revert-view"
import type { SessionMessageUser } from "@novaclaw/sdk/v2/client"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useTabs } from "@/context/tabs"
import { requireServerKey } from "@/utils/session-route"
import { createSessionOwnership } from "./session-ownership"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: { id: string } | undefined) => void
  focusInput: () => void
  review?: () => boolean
  /**
   * Stage a revert boundary through the session page's ONE revert mutation, and
   * move it forward / clear it through the ONE restore mutation — the same two the revert dock
   * uses.
   *
   * ⚠️ Injected rather than called here on purpose. Staging is not just the HTTP call: the server
   * writes the boundary to `SessionTable` from its own projector and never publishes a
   * `session.updated`, so the CLIENT record only learns about it from the refetch that those
   * mutations perform. `/undo` used to POST `revert.stage` on its own, and the result was a revert
   * that was real on the server and invisible in the UI — no dock, reverted turn still drawn, and
   * a failed stage reported as success (ruling 2). Any new caller must come through here.
   */
  stageRevert: (messageID: string) => Promise<unknown> | undefined
  restoreRevert: (messageID: string) => Promise<unknown> | undefined
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const sdk = useSDK()
  const settings = useSettings()
  const sync = useSync()
  const serverSync = useServerSync()
  const terminal = useTerminal()
  const sessionTabs = useTabs()
  const layout = useLayout()
  const navigate = useNavigate()
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const openDialog = async <T,>(load: () => Promise<T>, show: (value: T) => void) => {
    const owner = sessionOwnership.capture()
    const value = await load()
    owner.run(() => show(value))
  }
  const info = () => {
    const id = params.id
    if (!id) return
    return sync().session.get(id)
  }
  const hasReview = () => !!params.id
  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: actions.review,
    hasReview,
  })
  const activeFileTab = tabState.activeFileTab
  const closableTab = tabState.closableTab
  const shown = settings.visibility.fileTree

  const messages = () => {
    const id = params.id
    if (!id) return []
    return serverSync().nativeMessages.messages(id) ?? []
  }
  const userMessages = () => messages().filter((m): m is SessionMessageUser => m.type === "user")
  const visibleUserMessages = () => selectVisibleMessages(userMessages(), info()?.revert?.messageID)

  const showAllFiles = () => {
    if (layout.fileTree.tab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const canAddSelectionContext = () => {
    const tab = activeFileTab()
    if (!tab) return false
    const path = file.pathFromTab(tab)
    if (!path) return false
    return file.selectedLines(path) != null
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const setActiveMessage = actions.setActiveMessage
  const focusInput = actions.focusInput

  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const isAutoAcceptActive = () => {
    const sessionID = params.id
    if (sessionID) return permission.isAutoAccepting(sessionID, sdk().directory)
    return permission.isAutoAcceptingDirectory(sdk().directory)
  }
  const write = async (value: string) => {
    const body = typeof document === "undefined" ? undefined : document.body
    if (body) {
      const textarea = document.createElement("textarea")
      textarea.value = value
      textarea.setAttribute("readonly", "")
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      textarea.style.pointerEvents = "none"
      body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand("copy")
      body.removeChild(textarea)
      if (copied) return true
    }

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return false
    return clipboard.writeText(value).then(
      () => true,
      () => false,
    )
  }

  const openFile = () => {
    void openDialog(
      () => import("@/components/dialog-select-file"),
      (x) => dialog.show(() => <x.DialogSelectFile onOpenFile={showAllFiles} />),
    )
  }

  const closeTab = () => {
    const tab = closableTab()
    if (!tab) return
    tabs().close(tab)
  }

  const addSelection = () => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return

    const range = file.selectedLines(path) as SelectedLineRange | null | undefined
    if (!range) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })
      return
    }

    addSelectionToContext(path, selectionFromLines(range))
  }

  const openTerminal = () => {
    if (terminal.all().length > 0) terminal.new()
    view().terminal.open()
  }

  const chooseMcp = () => {
    void openDialog(
      () => import("@/components/dialog-select-mcp"),
      (x) => dialog.show(() => <x.DialogSelectMcp />),
    )
  }

  const toggleAutoAccept = () => {
    const sessionID = params.id
    if (sessionID) permission.toggleAutoAccept(sessionID, sdk().directory)
    else permission.toggleAutoAcceptDirectory(sdk().directory)

    const active = sessionID
      ? permission.isAutoAccepting(sessionID, sdk().directory)
      : permission.isAutoAcceptingDirectory(sdk().directory)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  /**
   * `/undo` — move the revert boundary back one prompt. A reversible POINTER MOVE: nothing is
   * deleted, `/redo` puts it back, and the dock's Discard is the only way to make it permanent.
   *
   * The whole sequence (interrupt if busy → optimistic boundary + composer draft → stage → refetch
   * the record → merge, with rollback + an error toast on failure) belongs to `stageRevert`, which
   * is the dock's mutation. This function only decides WHICH message and where the viewport lands.
   */
  const undo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const users = userMessages()
    const target = undoTargetID(users, info()?.revert?.messageID)
    if (!target) return
    // The viewport follows the last message still visible AFTER the boundary moves onto `target`.
    const previous = selectVisibleMessages(users, target).at(-1)

    await actions.stageRevert(target)
    owner.run(() => setActiveMessage(previous))
  }

  /** `/redo` — move the boundary forward one prompt, or clear it when nothing is left to restore. */
  const redo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const users = userMessages()
    const staged = info()?.revert?.messageID
    if (!staged) return
    const next = nextMessageID(users, staged)

    await actions.restoreRevert(staged)
    owner.run(() => setActiveMessage(next ? selectVisibleMessages(users, next).at(-1) : users.at(-1)))
  }

  const compact = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const model = local.model.current()
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
      })
      return
    }

    await sdk().client.v2.session.compact({
      sessionID,
    })
  }

  const fork = () => {
    void openDialog(
      () => import("@/components/dialog-fork"),
      (x) => dialog.show(() => <x.DialogFork />),
    )
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        if (params.serverKey) {
          sessionTabs.newDraft({ server: requireServerKey(params.serverKey), directory: sdk().directory })
          return
        }
        navigate(`/${params.dir}/session`)
      },
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: undo,
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !params.id || !info()?.revert?.messageID,
      onSelect: redo,
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: compact,
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: fork,
    }),
  ]

  const fileCmds = () => {
    const tab = closableTab()
    return [
      fileCommand({
        id: "file.open",
        title: language.t("command.file.open"),
        description: language.t("palette.search.placeholder"),
        keybind: "mod+k,mod+p",
        slash: "open",
        onSelect: openFile,
      }),
      tab &&
        fileCommand({
          id: "tab.close",
          title: language.t("command.tab.close"),
          keybind: "mod+w",
          onSelect: closeTab,
        }),
    ].filter((v) => !!v)
  }

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => view().terminal.toggle(),
    }),
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: () => view().reviewPanel.toggle(),
    }),
    ...(shown()
      ? [
          viewCommand({
            id: "fileTree.toggle",
            title: language.t("command.fileTree.toggle"),
            keybind: "mod+\\",
            onSelect: () => layout.fileTree.toggle(),
          }),
        ]
      : []),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      onSelect: openTerminal,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: chooseMcp,
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: isAutoAcceptActive()
        ? language.t("command.permissions.autoaccept.disable")
        : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
    ...mcpCmds(),
    ...permissionsCmds(),
  ])
}
