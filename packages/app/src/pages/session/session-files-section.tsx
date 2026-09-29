import { Match, Show, Switch, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useFile } from "@/context/file"
import type { SessionChangeDiff, VcsFileDiff } from "@novaclaw/sdk/v2"
import FileTree from "@/components/file-tree"

/** The panel's own narrowed diff shape — reused rather than re-narrowed, so the two cannot drift. */
type RenderedDiff = (SessionChangeDiff & { file: string }) | VcsFileDiff

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

  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }
    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")
    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of props.diffs) {
      const path = diff.file
      if (!path) continue
      const file = normalize(path)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"
      // The file itself, then every directory above it, so both are coloured.
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
  const diffFiles = createMemo(() => props.diffs.map((diff) => diff.file).filter((f): f is string => !!f))
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
