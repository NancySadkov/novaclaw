import { useDialog } from "@novaclaw/ui/context/dialog"
import { createQuery, skipToken, useQueryClient } from "@tanstack/solid-query"
import {
  onCleanup,
  Show,
  Match,
  Switch,
  ErrorBoundary,
  createMemo,
  createSignal,
  createEffect,
  createComputed,
  on,
  onMount,
  untrack,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { debounce } from "@solid-primitives/scheduled"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@novaclaw/ui/resize-handle"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { previewSelectedLines } from "@novaclaw/session-ui/pierre/selection-bridge"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@novaclaw/core/util/encode"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { useConfirm } from "@/components/dialog-confirm"
import { useComments } from "@/context/comments"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { retrySessionExecution, sessionExecutions, stopSessionExecution } from "@/utils/session-execution-api"
import { recoveryChangesNote } from "./session-recovery-note"
import { PromptInput } from "@/components/prompt-input"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import {
  createPromptInputController,
  createSessionComposerController,
  createSessionComposerRegionController,
  SessionComposerRegion,
} from "@/pages/session/composer"
import { createOpenReviewFile, createSessionTabs, createSizing } from "@/pages/session/helpers"
import { createSessionKeyboardController } from "@/pages/session/keyboard-controller"
import { NativeTimeline, type NativeTimelineController } from "@/pages/session/timeline/native-timeline"
import { unpinSessionDevice } from "@/pages/session/timeline/device-repair"
import { createTimelineModel } from "@/pages/session/timeline/model"
import { createSessionRevertController } from "@/pages/session/revert-controller"
import { createReviewNavigation } from "@/pages/session/review-navigation"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { Identifier } from "@/utils/id"
import { diffs as list } from "@/utils/diffs"
import { Persist, persisted } from "@/utils/persist"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { createSessionOwnership } from "./session/session-ownership"
import { presenceHandoffNotice, presenceView } from "./session/session-presence"
import { createSessionPresence } from "./session/session-presence-controller"
import { createReviewController, resolveReviewSource, type ChangeMode } from "./session/review-source"
import { visibleProviderRecovery } from "./session/composer/session-provider-recovery"

type VcsMode = "git" | "branch"

const sessionViewState = () => ({
  mobileTab: "session" as "session" | "changes",
  changes: "git" as ChangeMode,
})

export default function Page() {
  const serverSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const confirm = useConfirm()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const server = useServer()
  const platform = usePlatform()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const navigate = useNavigate()
  const { params, sessionKey, workspaceKey, tabs, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)

  // ── Presence ────────────────────────────────────────────────────────────────────────────────
  // Who else is looking at this chat, who is driving, and what happens when two surfaces reach for
  // it at once. The rules live in ./session/session-presence.ts (pure) and the instance owns the
  // truth; this is the surface. Busy is NOT read from here — `session_working` stays the one
  // answer to "is the agent working", so the two can never disagree.
  const presence = createSessionPresence({
    sessionID: () => params.id,
    label: () => language.t(platform.platform === "desktop" ? "presence.viewer.desktop" : "presence.viewer.browser"),
    writing: () => prompt.dirty(),
    report: (report) => serverSync().session.reportPresence(report),
  })
  const presenceSnapshot = createMemo(() =>
    params.id ? serverSync().session.data.session_presence[params.id] : undefined,
  )
  const presenceState = createMemo(() => presenceView(presenceSnapshot(), presence.viewerID))
  // A handoff notice outlives the situation that produced it (the driver closing their tab leaves
  // ONE person in the room who still needs telling), so it needs a clock of its own to fade out.
  // Five seconds is coarse enough to cost nothing and fine enough that a 20-second notice does not
  // visibly overstay.
  const [presenceClock, setPresenceClock] = createSignal(Date.now())
  const presenceTicker = setInterval(() => setPresenceClock(Date.now()), 5_000)
  onCleanup(() => clearInterval(presenceTicker))
  const presenceHandoff = createMemo(() =>
    presenceHandoffNotice(presenceSnapshot(), presence.viewerID, presenceClock()),
  )

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    reviewSnap: false,
  })

  const composer = createSessionComposerController()
  const [recoveryDismissed, setRecoveryDismissed] = createSignal<string>()
  const inputController = createPromptInputController({
    sessionID: () => params.id,
    queryOptions: serverSync().queryOptions,
  })

  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }
        if (pending.scope !== serverSDK().scope) return

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== base64Encode(sdk().directory)) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen())
  const sessionPanelWidth = createMemo(() => {
    // The REVIEW no longer takes width from the conversation — it floats above it (owner,
    // 2026-08-12). Only the file tree, which is a navigation rail rather than a document, still
    // shares the row.
    if (!desktopFileTreeOpen()) return "100%"
    return `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const diffs = createMemo(() => (params.id ? list(sync().data.session_diff[params.id]) : []))
  // T3 (entities.md): review affordances gate on VCS data, not a project entity.
  const canReview = createMemo(() => !!sync().data.vcs)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const timeline = createTimelineModel({ sessionID: () => params.id, revertMessageID })
  const messagesReady = timeline.ready
  const sessionSync = timeline.resource
  const userMessages = timeline.userMessages
  const visibleUserMessages = timeline.visibleUserMessages

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  createEffect(
    on(
      () => info()?.model?.id,
      () => {
        const session = info()
        if (!session?.agent || !session.model) return
        syncSessionModel(local, {
          sessionID: session.id,
          agent: session.agent,
          model: {
            providerID: session.model.providerID,
            modelID: session.model.id,
            variant: session.model.variant,
          },
        })
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: sdk().directory, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    ...sessionViewState(),
    newSessionWorktree: "main",
    deferRender: false,
  })

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      const owner = sessionOwnership.capture()
      requestAnimationFrame(() => {
        setTimeout(() => owner.run(() => setStore("deferRender", false)), 0)
      })
    }
    return key
  })

  let reviewFrame: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  // Native: the session-changes review reads the session record's summary diffs
  // (`info().summary.diffs`), not a per-user-message summary (native user messages carry none).
  const turnDiffs = createMemo(() => list(info()?.summary?.diffs))
  const changesOptions = createMemo<ChangeMode[]>(() => {
    const list: ChangeMode[] = []
    const vcs = sync().data.vcs
    if (vcs) list.push("git")
    if (vcs?.branch && vcs?.default_branch && vcs.branch !== vcs.default_branch) {
      list.push("branch")
    }
    list.push("turn")
    return list
  })
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes",
  )
  const sessionStatus = () => sync().data.session_status[params.id ?? ""]?.type ?? "idle"
  const executionQuery = createQuery(() => ({
    queryKey: ["session-execution", server.current?.http.url ?? "", params.id ?? ""],
    enabled: !!server.current && !!params.id,
    queryFn: () => sessionExecutions(server.current!.http, params.id),
    refetchInterval: 2_000,
  }))
  const executionAttempt = createMemo(() => executionQuery.data?.find((item) => item.sessionID === params.id))
  /** Wording lives in `session-recovery-note.ts` so its branches are provable — the zero-and-
   *  incomplete case in particular must never read as "nothing happened". */
  const recoveryChanges = createMemo(() => recoveryChangesNote(info()?.summary))

  /**
   * The banner's third affordance — what the session-recovery gate called `reconcile`.
   *
   * ⚠️ It is deliberately NOT a third verb. The gate named a word that appeared nowhere in the
   * product, and the honest reading of it is *make the record agree with what actually happened* —
   * which nobody can do without first SEEING what happened. Everything needed for the two real
   * answers already ships: the Changes panel shows the diff, and the per-prompt Revert undoes the
   * turn. What was missing is only the step between "at least 2 files changed" and either of them,
   * so the banner now takes you there instead of naming a fourth thing to learn.
   *
   * ⚠️ BOTH calls are required, and the first version of this shipped only `setTab`. `setTab` sets
   * `opened: true` ONLY when the fileTree store is still unset — after any prior interaction it
   * changes the tab and leaves a closed panel closed. Caught by clicking the button in a browser
   * against a genuinely paused session, not by reading `layout.tsx`: the signature reads like it
   * opens.
   */
  const showChangedFiles = () => {
    if (!isDesktop()) {
      setStore("mobileTab", "changes")
      return
    }
    layout.fileTree.open()
    layout.fileTree.setTab("changes")
  }

  const executionAction = async (action: "retry" | "stop") => {
    const conn = server.current
    const id = params.id
    if (!conn || !id) return
    try {
      if (action === "retry") await retrySessionExecution(conn.http, id, sdk().directory)
      else await stopSessionExecution(conn.http, id, sdk().directory)
      await executionQuery.refetch()
    } catch (error) {
      showToast({
        title: action === "retry" ? "Could not retry this chat" : "Could not stop this chat",
        description: String(error),
        variant: "error",
      })
    }
  }
  const reviewSource = createMemo(() =>
    resolveReviewSource({
      selected: store.changes,
      status: sessionStatus(),
      summaryComplete: info()?.summary?.complete,
      hasVcs: !!sync().data.vcs,
    }),
  )
  const vcsMode = createMemo<VcsMode | undefined>(() => {
    const mode = reviewSource().mode
    if (mode === "git" || mode === "branch") return mode
  })
  const vcsKey = createMemo(
    () =>
      ["session-vcs", sdk().directory, sync().data.vcs?.branch ?? "", sync().data.vcs?.default_branch ?? ""] as const,
  )
  const vcsQuery = createQuery(() => {
    const mode = vcsMode()
    const enabled = wantsReview() && !!sync().data.vcs

    return {
      queryKey: [...vcsKey(), mode] as const,
      enabled,
      queryFn: mode
        ? () =>
            sdk()
              .client.v2.vcs.diff({ mode })
              .then((result) => list(result.data?.data))
        : skipToken,
    }
  })
  const refreshVcs = debounce(() => void queryClient.invalidateQueries({ queryKey: vcsKey() }), 100)
  const review = createReviewController({
    source: reviewSource,
    recorded: turnDiffs,
    recordedRevision: () => info()?.summary?.to,
    vcs: () => vcsQuery.data,
    vcsFetched: () => vcsQuery.isFetched,
    vcsPending: () => vcsQuery.isPending,
    vcsError: () => vcsQuery.error,
  })
  const reviewDiffs = review.diffs
  const reviewCount = review.count
  const hasReview = () => reviewCount() > 0
  const reviewReady = review.ready
  const reviewRevision = review.revision

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    return "main"
  })

  let inputRef!: HTMLDivElement
  let timelineController: NativeTimelineController | undefined
  const navigateMessageByOffset = (offset: number) => timelineController?.navigateUser(offset)
  const setActiveMessage = (message: { id: string } | undefined) => timelineController?.scrollToUser(message?.id)
  const resumeScroll = () => timelineController?.scrollToBottom()

  createEffect(
    on(
      () => {
        const id = params.id
        return [sdk().directory, id, id ? (sync().data.session_status[id]?.type ?? "idle") : "idle"] as const
      },
      ([dir, id, status]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle") return
        const cached = untrack(() => sync().data.todo[id] !== undefined)

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk().directory !== dir || params.id !== id) return
            untrack(() => {
              void sync().session.todo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore(sessionViewState())
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk().event.listen((evt) => {
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  createEffect(
    on(
      () => sdk().directory,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const handleKeyDown = createSessionKeyboardController({
    composer: () => inputRef,
    childSession: isChildSession,
    dialogActive: () => !!dialog.active,
    terminalOpen: () => view().terminal.opened(),
    activeTerminal: terminal.active,
  })

  createEffect(() => {
    if (!sync().data.vcs) return
    const list = changesOptions()
    if (list.includes(store.changes)) return
    const next = list[0]
    if (!next) return
    setStore("changes", next)
  })

  createEffect(
    on(
      () => sync().data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  const revertController = createSessionRevertController({
    sessionID: () => params.id,
    revertMessageID,
    userMessages,
    sdk,
    serverSync,
    sync,
    prompt,
    language,
    confirm,
  })
  const {
    busy,
    chooseAnotherModel,
    discardRolled,
    restore,
    restoring,
    retryFailedTurn,
    revert,
    reverting,
    revertToPrompt,
    rolled,
  } = revertController

  const unpinDevice = async (sessionID: string) => {
    try {
      await unpinSessionDevice(sdk().client, sessionID)
    } catch (error) {
      showToast({
        title: language.t("session.device.unpinFailed"),
        description: String(error),
        variant: "error",
      })
      throw error
    }
  }

  useComposerCommands()
  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    review: reviewTab,
    // `/undo` and `/redo` route through the SAME two mutations as the revert dock. They used to
    // call `client.v2.session.revert.stage` directly and skipped the record refetch, so the client
    // never learned a revert was staged: no dock, no hidden messages, no error toast on failure.
    stageRevert: (messageID) => (params.id ? revert({ sessionID: params.id, messageID }) : undefined),
    restoreRevert: (messageID) => restore(messageID),
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesTitle = () => {
    if (!canReview()) {
      return null
    }

    const label = (option: ChangeMode) => {
      if (option === "git") return language.t("ui.sessionReview.title.git")
      if (option === "branch") return language.t("ui.sessionReview.title.branch")
      return language.t("ui.sessionReview.title.chat")
    }

    const sourceLabel = () => {
      const kind = reviewSource().kind
      if (kind === "live") return language.t("session.review.source.live")
      if (kind === "incomplete") return language.t("session.review.source.incomplete")
      if (kind === "recorded") return language.t("session.review.source.recorded")
    }

    return (
      <div class="flex items-center gap-2">
        {/* v1 asked for `variant="ghost" size="small"`, i.e. a 24px chrome-less trigger. That is
            exactly `appearance="inline"` (24px, transparent, hover overlay) — the sizes match to the
            pixel, so the v2 scale states this control's size instead of a Button size doing it. The
            `text-14-medium` valueClass goes with it: v2's inline value text is the design system's
            own step (13px/530), and pinning 14px here would re-fork the scale in a call site. */}
        <SelectV2
          appearance="inline"
          options={changesOptions()}
          current={store.changes}
          label={label}
          onSelect={(option) => option && setStore("changes", option)}
        />
        <Show when={store.changes === "turn" && sourceLabel()} keyed>
          {(value) => <span class="text-11-regular text-text-weak">{value}</span>}
        </Show>
      </div>
    )
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    if (reviewSource().kind === "live") return language.t("session.review.noLiveChanges")
    if (reviewSource().mode === "git") return language.t("session.review.noUncommittedChanges")
    if (reviewSource().mode === "branch") return language.t("session.review.noBranchChanges")
    return language.t("session.review.noChanges")
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (reviewSource().mode === "git" || reviewSource().mode === "branch") {
      if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      if (vcsQuery.isError)
        return (
          <div class={input.emptyClass}>
            <div class="flex max-w-72 flex-col items-center gap-3 text-center">
              <div class="text-14-regular text-text-weak">{language.t("session.review.loadFailed")}</div>
              <ButtonV2 size="small" variant="neutral" onClick={() => void vcsQuery.refetch()}>
                {language.t("session.review.retry")}
              </ButtonV2>
            </div>
          </div>
        )
      return empty(reviewEmptyText())
    }

    if (store.changes === "turn") {
      return empty(reviewEmptyText())
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{reviewEmptyText()}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        revision={reviewRevision()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        commentMentions={{
          items: file.searchFilesAndDirectories,
        }}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div
      classList={{
        "flex flex-col h-full overflow-hidden contain-strict bg-v2-background-bg-base": true,
      }}
    >
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewNavigation = createReviewNavigation({
    root: () => tree.reviewScroll,
    pending: () => tree.pendingDiff,
    ready: reviewReady,
    setPending: (path) => setTree("pendingDiff", path),
    setFocused: (path) => setTree("activeDiff", path),
    openPanel: openReviewPanel,
    openPath: (path) => view().review.openPath(path),
    saveScroll: (position) => view().setScroll("review", position),
  })
  const focusReviewDiff = reviewNavigation.focus

  createEffect(() => {
    const id = params.id
    if (!id) return

    if (!wantsReview()) return
    if (sync().data.session_diff[id] !== undefined) return
    if (sync().status === "loading") return

    void sync().session.diff(id)
  })

  createEffect(
    on(
      () => [sessionKey(), wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync().data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync().session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk().directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync().status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk().directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
  })

  const composerRegion = () => {
    const controller = createSessionComposerRegionController({
      state: composer,
      sessionKey,
      sessionID: () => params.id,
      prompt,
      ready: () => !store.deferRender && messagesReady(),
      centered,
      todo: {
        collapsed: () => view().todoCollapsed.get(),
        onToggle: () => view().todoCollapsed.set(!view().todoCollapsed.get()),
      },
      revert: () =>
        rolled().length > 0
          ? {
              items: rolled(),
              restoring: restoring(),
              disabled: reverting(),
              onRestore: restore,
              onDiscard: () => void discardRolled(),
            }
          : undefined,
      providerRecovery: () => {
        const session = info()
        if (!session) return
        const recovery = visibleProviderRecovery({
          recovery: session.providerRecovery,
          working: busy(session.id),
          dismissedAttemptID: recoveryDismissed(),
        })
        if (!recovery) return
        return {
          sessionID: session.id,
          recovery,
          onResume: () => setRecoveryDismissed(recovery.attemptID),
        }
      },
      openParent: () => {
        const id = info()?.parentID
        if (!id) return
        navigate(
          params.serverKey
            ? sessionHref(requireServerKey(params.serverKey), id)
            : legacySessionHref(sdk().directory, id),
        )
      },
      setPromptRef: (el) => {
        inputRef = el
      },
      setDockRef: () => {},
    })
    return (
      <SessionComposerRegion
        controller={controller}
        promptInput={
          <PromptInput
            controls={inputController()}
            ref={(el) => {
              inputRef = el
            }}
            newSessionWorktree={newSessionWorktree()}
            onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
            onSubmit={() => {
              comments.clear()
              resumeScroll()
            }}
          />
        }
      />
    )
  }

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {sessionSync() ?? ""}
      <SessionHeader />
      <Show when={executionAttempt()}>
        {(attempt) => (
          <Show when={["recovering", "paused", "failed", "interrupted"].includes(attempt().state)}>
            <div class="mx-2 mt-2 flex select-text items-center gap-3 rounded-[10px] border border-v2-state-border-warning bg-v2-state-bg-warning px-3 py-2 text-xs text-v2-text-text-muted">
              <span class="min-w-0 flex-1">
                <strong class="text-v2-text-text-base">
                  {attempt().state === "recovering" ? "This chat is recovering." : "This chat is paused safely."}
                </strong>{" "}
                {attempt().failureDetail ??
                  attempt().failureClass ??
                  "Execution stopped before Nova could confirm the outcome."}{" "}
                {/*
                  What already happened to the workspace, because that — not the failure class — is
                  what decides whether retrying is safe. `complete: false` means the recording was
                  still open when this stopped (`markChangesIncomplete` sets it at drain entry), so
                  the count is a FLOOR, not a total.

                  ⚠️ The dangerous case is zero-and-incomplete. Rendering "No files changed" there
                  would be a false reassurance at exactly the moment someone is deciding whether to
                  re-run a side effect, so it says the recording never finished instead.
                */}
                <span class="text-v2-text-text-muted">{recoveryChanges()}</span>
              </span>
              {/* Before Retry on purpose: "is retrying safe?" is answered by looking, and a banner
                  that offers the irreversible action first is teaching the wrong order. */}
              <ButtonV2 size="small" variant="neutral" onClick={showChangedFiles}>
                See changes
              </ButtonV2>
              <Show when={attempt().state !== "recovering"}>
                <ButtonV2 size="small" variant="neutral" onClick={() => void executionAction("retry")}>
                  Retry
                </ButtonV2>
              </Show>
              <Show when={attempt().state === "recovering"}>
                <ButtonV2 size="small" variant="neutral" onClick={() => void executionAction("stop")}>
                  Stop
                </ButtonV2>
              </Show>
            </div>
          </Show>
        )}
      </Show>
      {/*
        Presence. Deliberately NOT styled as a warning: two people in one chat is an ordinary thing
        that happens, and rendering it in the same red as a stalled execution would teach a normal
        user that they had done something wrong. It sits BELOW the recovery banner because a fault
        outranks company.
      */}
      <Show when={presenceState().line ?? presenceHandoff()}>
        <div
          data-slot="session-presence"
          data-presence-state={presenceSnapshot()?.state ?? "unattended"}
          data-presence-driving={presenceState().driving ? "true" : "false"}
          class="mx-2 mt-2 flex select-text items-center gap-3 rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 py-2 text-xs text-v2-text-text-muted"
        >
          <span class="min-w-0 flex-1">
            <Show when={presenceState().line}>
              {(line) => <span data-slot="session-presence-line">{language.t(line().key, line().values)}</span>}
            </Show>{" "}
            <Show when={presenceHandoff()}>
              {(line) => (
                <span data-slot="session-presence-handoff" class="text-v2-text-text-base">
                  {language.t(line().key, line().values)}
                </span>
              )}
            </Show>
          </span>
          <Show when={presenceState().canTakeOver}>
            <ButtonV2 size="small" variant="neutral" onClick={() => presence.takeOver()}>
              {language.t("presence.takeOver")}
            </ButtonV2>
          </Show>
        </div>
      </Show>
      {/* `gap-2` but no padding: the gap separates two PANES, which is real information, while the
          padding only inset the whole chat from the window's own edge (owner, 2026-08-13). */}
      <div class="flex-1 min-h-0 flex flex-col md:flex-row gap-2">
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full flex-1 md:flex-none transition-[width]": true,
            "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !size.active() && !ui.reviewSnap,
          }}
          style={{
            width: sessionPanelWidth(),
          }}
        >
          {/* The conversation IS the window here — no rounding, no elevation. A radius and a drop
              shadow describe something lying on top of a surface; the chat is the surface. */}
          <div class="flex-1 min-h-0 flex flex-col bg-v2-background-bg-base overflow-hidden">
            <div class="flex-1 min-h-0 overflow-hidden">
              <Switch>
                <Match when={params.id}>
                  <Show when={messagesReady() ? params.id : undefined} keyed>
                    {(_id) => (
                      /**
                       * 🔴 **The transcript gets its OWN boundary, because a row it cannot read is a
                       * normal event** (owner, 2026-08-27: *"assistant failing to read something is
                       * not a fatal error, but a normal event"*).
                       *
                       * This app had exactly ONE ErrorBoundary, at its root, so ANY throw while
                       * rendering a message replaced the entire application with the fatal error page
                       * — chat, sidebar, settings and all. Measured in shipped 0.1.67: one assistant
                       * row arrived without the `time` struct its schema declares required, and
                       * `Cannot read properties of undefined (reading 'time')` took the whole UI down
                       * mid-conversation.
                       *
                       * ⚠️ Guarding that one field is not the fix, it is the instance. A transcript
                       * renders arbitrary model output through dozens of cards, so "some row is
                       * shaped in a way one card did not expect" is a permanent condition of the
                       * feature, not a bug that gets fixed once. The containment is what makes it
                       * survivable: the fault stays inside the transcript, the rest of the app keeps
                       * working, and `reset` re-renders once the store moves on — *degrade and
                       * recover*, never a stack trace and a dead end (AGENTS.md, "it never breaks in
                       * your hands").
                       */
                      <ErrorBoundary
                        fallback={(error, reset) => {
                          // Boundary-caught faults never reach window.onerror. Log it, so the Debug
                          // app's error ring shows the real failure rather than only the calm card.
                          console.error("session timeline boundary", error)
                          return (
                            <div class="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                              <p class="max-w-80 text-12-regular text-text-muted">
                                {language.t("session.timeline.degraded")}
                              </p>
                              <ButtonV2 size="small" variant="neutral" onClick={reset}>
                                {language.t("session.review.retry")}
                              </ButtonV2>
                            </div>
                          )
                        }}
                      >
                        <NativeTimeline
                          sessionID={_id}
                          setController={(controller) => (timelineController = controller)}
                          directory={sdk().directory}
                          onRevert={revertToPrompt}
                          onRetry={retryFailedTurn}
                          onChooseModel={chooseAnotherModel}
                          onUnpinDevice={unpinDevice}
                          onStopCommand={async (reason) => {
                            const conn = server.current
                            if (!conn) return
                            await stopSessionExecution(conn.http, _id, sdk().directory, reason)
                          }}
                          revertMessageID={revertMessageID()}
                        />
                      </ErrorBoundary>
                    )}
                  </Show>
                </Match>
                <Match when={true}>
                  <NewSessionView />
                </Match>
              </Switch>
            </div>

            <Show when={params.id}>{(_) => composerRegion()}</Show>
          </div>

          <Show when={desktopReviewOpen()}>
            <div onPointerDown={() => size.start()}>
              <ResizeHandle
                classList={{ "-right-1": true }}
                direction="horizontal"
                size={layout.session.width()}
                min={450}
                max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                onResize={(width) => {
                  size.touch()
                  layout.session.resize(width)
                }}
              />
            </div>
          </Show>
        </div>

        <SessionSidePanel
          canReview={canReview}
          diffs={reviewDiffs}
          diffsReady={reviewReady}
          empty={reviewEmptyText}
          hasReview={hasReview}
          reviewCount={reviewCount}
          reviewPanel={reviewPanel}
          activeDiff={tree.activeDiff}
          focusReviewDiff={focusReviewDiff}
          reviewSnap={ui.reviewSnap}
          size={size}
        />
      </div>

      <TerminalPanel />
    </div>
  )
}
