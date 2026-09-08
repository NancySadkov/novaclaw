import { For, Match, Show, Switch, createEffect, createMemo, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic, Portal } from "solid-js/web"

/** Renders children where they already are — the non-modal arm of the portal switch, so the
 *  in-flow rail gains no wrapper element and its flex sizing is untouched. */
const PassThrough = (props: { children?: JSX.Element }) => <>{props.children}</>
import { createMediaQuery } from "@solid-primitives/media"
import { TabsV2 } from "@novaclaw/ui/v2/tabs-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { TooltipKeybindV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { ResizeHandle } from "@novaclaw/ui/resize-handle"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SessionChangeDiff, VcsFileDiff } from "@novaclaw/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@novaclaw/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { publicAssetUrl } from "@/utils/public-asset"

type RenderDiff = (SessionChangeDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SessionChangeDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SessionChangeDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  // Review/context is a modal and remains reachable at every width. Only the docked file tree is
  // desktop-only; coupling both to `isDesktop()` made a narrow context-button click update hidden
  // state with no dialog on screen.
  const reviewOpen = createMemo(() => view().reviewPanel.opened())
  const fileOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  /**
   * Review floats; the file tree does not. `asModal` is the one switch, so every rule below reads
   * from it rather than re-deriving "is this the review?" in four places.
   */
  const asModal = createMemo(() => reviewOpen())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    // An overlay sizes itself; a rail is sized by the layout that contains it.
    if (asModal()) return "min(1100px, 92vw)"
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={!!params.id && (isDesktop() || reviewOpen())}>
      {/*
        ⚠️ PORTALLED to <body>, and measured rather than assumed: with `position: fixed` alone the
        dialog rendered at x=1360 in a 1280 viewport — off screen. An ancestor here carries
        `contain-strict` and another `will-change: width`, and either makes a fixed child position
        against THAT box rather than the viewport. Hunting the ancestor would fix today only; any
        future one gaining `transform`, `filter` or `contain` would break the centring again.
      */}
      <Dynamic component={asModal() ? Portal : PassThrough}>
        {/* The scrim CLOSES on click — an overlay you cannot dismiss by clicking away from reads as
            a stuck screen. */}
        <Show when={asModal() && open()}>
          <div
            data-slot="review-modal-scrim"
            class="fixed inset-0 z-40 bg-[var(--v2-overlay-scrim,rgba(0,0,0,0.45))]"
            onClick={() => view().reviewPanel.close()}
          />
        </Show>
        <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        aria-modal={asModal() ? true : undefined}
        role={asModal() ? "dialog" : undefined}
        inert={!open()}
        // ⚠️ `relative` is NOT in the base class. It and `fixed` share Tailwind specificity, so the
        // winner is decided by STYLESHEET order rather than the order written here — measured: the
        // modal computed `position: relative` and sat 350px low while its `translate` applied
        // correctly, which is exactly what made the cause hard to see.
        class="min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          relative: !asModal(),
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap && !asModal(),
          "overflow-hidden": true,
          // Rounding + elevation ONLY as the centred overlay, where the panel really does float over
          // the conversation. Docked, it is a pane of the window like the chat beside it, and a
          // rounded shadowed sibling next to a square one just looks like a mistake.
          "rounded-[10px] shadow-[var(--v2-elevation-raised)]": asModal(),
          "flex-1": reviewOpen() && !asModal(),
          // Centred overlay rather than a flex sibling. `h-[88vh]` leaves the conversation visible
          // behind it, which is the point of a modal here: you are reviewing something you can
          // still see the context of.
          "fixed left-1/2 top-1/2 z-50 !h-[88vh] -translate-x-1/2 -translate-y-1/2": asModal(),
        }}
        style={{ width: panelWidth() }}
      >
        {/* ⚠️ A real close button. This overlay replaces a header toggle the user could always see;
            leaving only click-outside would remove the affordance that made it discoverable. */}
        <Show when={asModal() && open()}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            data-slot="review-modal-close"
            class="absolute right-2 top-2 z-10"
            icon={<IconV2 name="xmark-small" />}
            aria-label={language.t("common.close")}
            onClick={() => view().reviewPanel.close()}
          />
        </Show>
        <Show when={open()}>
          <div class="size-full flex">
            <div
              aria-hidden={!reviewOpen()}
              inert={!reviewOpen()}
              class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
              classList={{
                "pointer-events-none": !reviewOpen(),
              }}
            >
              <div class="size-full min-w-0 h-full bg-background-base">
                <DragDropProvider
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragYAxis />
                  <TabsV2 value={activeTab()} onChange={openTab}>
                    <div class="sticky top-0 shrink-0 flex">
                      <TabsV2.List
                        ref={(el: HTMLDivElement) => {
                          const stop = createFileTabListSync({ el, contextOpen })
                          onCleanup(stop)
                        }}
                      >
                        <Show when={reviewTab() && props.canReview()}>
                          <TabsV2.Trigger value="review">
                            <div class="flex items-center gap-1.5">
                              <div>{language.t("session.tab.review")}</div>
                              <Show when={props.hasReview()}>
                                <div>{props.reviewCount()}</div>
                              </Show>
                            </div>
                          </TabsV2.Trigger>
                        </Show>
                        <Show when={contextOpen()}>
                          <TabsV2.Trigger
                            value="context"
                            closeButton={
                              <TooltipKeybindV2
                                title={language.t("common.closeTab")}
                                keys={command.keybindParts("tab.close")}
                                placement="bottom"
                                gutter={10}
                              >
                                <IconButtonV2
                                  icon={<IconV2 name="close-small" />}
                                  variant="ghost-muted"
                                  class="h-5 w-5"
                                  onClick={() => tabs().close("context")}
                                  aria-label={language.t("common.closeTab")}
                                />
                              </TooltipKeybindV2>
                            }
                            onMiddleClick={() => tabs().close("context")}
                          >
                            <div class="flex items-center gap-2">
                              <SessionContextUsage variant="indicator" />
                              <div>{language.t("session.tab.context")}</div>
                            </div>
                          </TabsV2.Trigger>
                        </Show>
                        <SortableProvider ids={openedTabs()}>
                          <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                        </SortableProvider>
                        <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                          <TooltipKeybindV2
                            title={language.t("command.file.open")}
                            keys={command.keybindParts("file.open")}
                            class="flex items-center"
                          >
                            <IconButtonV2
                              icon={<IconV2 name="plus-small" size="large" />}
                              variant="ghost-muted"
                              class="!rounded-md"
                              onClick={() => {
                                void import("@/components/dialog-select-file").then((x) => {
                                  dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                                })
                              }}
                              aria-label={language.t("command.file.open")}
                            />
                          </TooltipKeybindV2>
                        </div>
                      </TabsV2.List>
                    </div>

                    <Show when={reviewTab() && props.canReview()}>
                      <TabsV2.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={reviewOpen() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </TabsV2.Content>
                    </Show>

                    <TabsV2.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "empty"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                            <img
                              src={publicAssetUrl("/logo.png")}
                              alt=""
                              draggable={false}
                              class="w-14 opacity-10 select-none"
                            />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </Show>
                    </TabsV2.Content>

                    <Show when={contextOpen()}>
                      <TabsV2.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab />
                          </div>
                        </Show>
                      </TabsV2.Content>
                    </Show>

                    <Show when={activeFileTab()} keyed>
                      {(tab) => <FileTabContent tab={tab} />}
                    </Show>
                  </TabsV2>
                  <DragOverlay>
                    <Show when={store.activeDraggable} keyed>
                      {(tab) => {
                        const path = file.pathFromTab(tab)
                        return (
                          <div data-component="tabs-drag-preview">
                            <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                          </div>
                        )
                      }}
                    </Show>
                  </DragOverlay>
                </DragDropProvider>
              </div>
            </div>

            <div
              id="file-tree-panel"
              aria-hidden={!fileOpen()}
              inert={!fileOpen()}
              class="relative min-w-0 h-full shrink-0 overflow-hidden"
              classList={{
                "pointer-events-none": !fileOpen(),
                "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !props.size.active(),
              }}
              style={{ width: treeWidth() }}
            >
              <div
                class="h-full flex flex-col overflow-hidden group/filetree"
                classList={{ "border-l border-border-weaker-base": reviewOpen() }}
              >
                <TabsV2 variant="pill" value={fileTreeTab()} onChange={setFileTreeTabValue} class="h-full">
                  <TabsV2.List>
                    {/* No `classes={{ button }}` shim (ruling 13): v2's pill trigger is already
                        `width: 100%; height: 100%` inside the flex-1 wrapper. */}
                    <TabsV2.Trigger value="changes" class="flex-1">
                      {props.reviewCount()}{" "}
                      {language.plural("session.review.change", props.reviewCount())}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="all" class="flex-1">
                      {language.t("session.files.all")}
                    </TabsV2.Trigger>
                  </TabsV2.List>
                  <TabsV2.Content value="changes" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={props.hasReview() || !props.diffsReady()}>
                        <Show
                          when={props.diffsReady()}
                          fallback={
                            <div class="px-2 py-2 text-12-regular text-text-weak">
                              {language.t("common.loading")}
                              {language.t("common.loading.ellipsis")}
                            </div>
                          }
                        >
                          <FileTree
                            path=""
                            class="pt-3"
                            allowed={diffFiles()}
                            kinds={kinds()}
                            draggable={false}
                            active={props.activeDiff}
                            onFileClick={(node) => props.focusReviewDiff(node.path)}
                          />
                        </Show>
                      </Match>
                    </Switch>
                  </TabsV2.Content>
                  <TabsV2.Content value="all" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                      <Match when={true}>
                        <FileTree
                          path=""
                          class="pt-3"
                          modified={diffFiles()}
                          kinds={kinds()}
                          onFileClick={(node) => openTab(file.tab(node.path))}
                        />
                      </Match>
                    </Switch>
                  </TabsV2.Content>
                </TabsV2>
              </div>
              <Show when={fileOpen()}>
                <div onPointerDown={() => props.size.start()}>
                  <ResizeHandle
                    direction="horizontal"
                    edge="start"
                    size={layout.fileTree.width()}
                    min={200}
                    max={480}
                    onResize={(width) => {
                      props.size.touch()
                      layout.fileTree.resize(width)
                    }}
                  />
                </div>
              </Show>
            </div>
          </div>
        </Show>
        </aside>
      </Dynamic>
    </Show>
  )
}
