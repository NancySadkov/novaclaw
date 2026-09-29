import { Match, Show, Switch, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useFile } from "@/context/file"
import FileTree from "@/components/file-tree"
import { diffKinds, diffPaths, type RenderedDiff } from "./session-files-derive"

/**
 * The file list and the changes list, moved here from the side panel's `Changes`/`All files` pill.
 *
 * The context inspector is the one official route to a session's stats, so the pill was a second,
 * unowned answer to the same question — but it was also the app's only file browser and diff view.
 * The two `FileTree` lists are therefore carried here rather than reimplemented, with the click
 * behaviour unchanged: a changed file focuses its diff, a listed file opens as a tab.
 */
export function SessionFilesSection(props: {
  /** Already narrowed by the panel's `renderDiff`, so `file` is present and the kind is readable. */
  readonly diffs: readonly RenderedDiff[]
  readonly diffsReady: () => boolean
  readonly canReview: () => boolean
  readonly hasReview: () => boolean
  readonly reviewCount: () => number
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
    <section data-slot="context-files" class="relative min-w-0">
      <div data-slot="context-section-head" class="px-3 py-2 text-12-regular text-text-weak">
        {props.reviewCount()} {language.plural("session.review.change", props.reviewCount())}
      </div>
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
      <div data-slot="context-section-head" class="px-3 py-2 text-12-regular text-text-weak">
        {language.t("session.files.all")}
      </div>
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
    </section>
  )
}
