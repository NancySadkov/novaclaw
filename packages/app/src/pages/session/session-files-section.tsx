import { Match, Show, Switch, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useFile } from "@/context/file"
import FileTree from "@/components/file-tree"
import { diffKinds, diffPaths, type RenderedDiff } from "./session-files-derive"

export function SessionFilesSection(props: {
  readonly mode: "changes" | "all"
  /** Already narrowed by the panel's `renderDiff`, so `file` is present and the kind is readable. */
  readonly diffs: readonly RenderedDiff[]
  readonly diffsReady: () => boolean
  readonly canReview: () => boolean
  readonly hasReview: () => boolean
  /** The file whose diff is focused, so the tree highlights it. */
  readonly activeDiff: string | undefined
  readonly focusDiff: (path: string) => void
  readonly openFile: (path: string) => void
}) {
  const file = useFile()
  const language = useLanguage()

  const kinds = createMemo(() => diffKinds(props.diffs))
  const diffFiles = createMemo(() => diffPaths(props.diffs))
  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  return (
    <section data-slot="session-files" class="relative min-w-0">
      <Show when={props.mode === "changes"}>
        <div data-slot="context-files-changes" class="min-h-0">
          <Switch>
            <Match when={!props.canReview() || (!props.hasReview() && props.diffsReady())}>
              <div class="px-3 py-2 text-12-regular text-text-weak">{language.t("session.review.noChanges")}</div>
            </Match>
            <Match when={true}>
              <Show
                when={props.diffsReady()}
                fallback={
                  <div class="px-3 py-2 text-12-regular text-text-weak">
                    {language.t("session.review.loadingChanges")}
                  </div>
                }
              >
                <FileTree
                  path=""
                  class="pt-1"
                  allowed={diffFiles()}
                  kinds={kinds()}
                  draggable={false}
                  active={props.activeDiff}
                  onFileClick={(node: { path: string }) => props.focusDiff(node.path)}
                />
              </Show>
            </Match>
          </Switch>
        </div>
      </Show>
      <Show when={props.mode === "all"}>
        <div data-slot="context-files-all" class="min-h-0">
          <Switch>
            <Match when={nofiles()}>
              <div class="px-3 py-2 text-12-regular text-text-weak">{language.t("session.files.empty")}</div>
            </Match>
            <Match when={true}>
              <FileTree
                path=""
                class="pt-1"
                modified={diffFiles()}
                kinds={kinds()}
                onFileClick={(node: { path: string }) => props.openFile(node.path)}
              />
            </Match>
          </Switch>
        </div>
      </Show>
    </section>
  )
}
