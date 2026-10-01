import { Show, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import type { SessionChangeDiff, VcsFileDiff } from "@novaclaw/sdk/v2"
import { TabsV2 } from "@novaclaw/ui/v2/tabs-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { ScrollView } from "@novaclaw/ui/scroll-view"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { SessionContextTab } from "@/components/session"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { FileTabContent } from "./file-tabs"
import { SessionFilesSection } from "./session-files-section"
import { useSessionLayout } from "./session-layout"

type RenderDiff = (SessionChangeDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SessionChangeDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function OfficerStatsScreen(props: {
  canReview: () => boolean
  diffs: () => (SessionChangeDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
}) {
  const file = useFile()
  const language = useLanguage()
  const { params, view } = useSessionLayout()
  const section = () => view().reviewPanel.section()
  const selectedFile = () => view().reviewPanel.selectedFile()
  const diffs = createMemo(() => props.diffs().filter(renderDiff))

  const openFile = (path: string) => {
    file.load(path)
    view().reviewPanel.openFile(path)
  }

  return (
    <Show when={!!params.id && view().reviewPanel.opened()}>
      <AppPage data-screen="officer-stats" class="flex size-full min-h-0 min-w-0 flex-col">
        <AppPageHeader title={language.t("context.officerStats.title")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            class="ml-auto"
            icon={<Icon name="xmark-small" />}
            aria-label={language.t("common.close")}
            onClick={() => view().reviewPanel.close()}
          />
        </AppPageHeader>
        <TabsV2 value={section()} onChange={(value) => view().reviewPanel.setSection(value as "context" | "changes" | "all")} class="flex min-h-0 flex-1 flex-col">
          <TabsV2.List>
            <TabsV2.Trigger value="context">{language.t("session.tab.context")}</TabsV2.Trigger>
            <TabsV2.Trigger value="changes">
              {props.reviewCount()} {language.plural("session.review.change", props.reviewCount())}
            </TabsV2.Trigger>
            <TabsV2.Trigger value="all">{language.t("session.files.all")}</TabsV2.Trigger>
          </TabsV2.List>
          <TabsV2.Content value="context" class="min-h-0 flex-1 overflow-hidden">
            <SessionContextTab />
          </TabsV2.Content>
          <TabsV2.Content value="changes" class="min-h-0 flex-1 overflow-hidden">
            <div class="flex h-full min-h-0 flex-col md:flex-row">
              <ScrollView class="min-h-0 max-h-[35dvh] shrink-0 border-b border-v2-border-border-base md:max-h-none md:w-64 md:border-b-0 md:border-r">
                <SessionFilesSection
                  mode="changes"
                  diffs={diffs()}
                  diffsReady={props.diffsReady}
                  canReview={props.canReview}
                  hasReview={props.hasReview}
                  activeDiff={props.activeDiff}
                  focusDiff={props.focusReviewDiff}
                  openFile={openFile}
                />
              </ScrollView>
              <div class="min-h-0 min-w-0 flex-1">{props.reviewPanel()}</div>
            </div>
          </TabsV2.Content>
          <TabsV2.Content value="all" class="min-h-0 flex-1 overflow-hidden">
            <div class="flex h-full min-h-0 flex-col md:flex-row">
              <ScrollView class="min-h-0 max-h-[35dvh] shrink-0 border-b border-v2-border-border-base md:max-h-none md:w-64 md:border-b-0 md:border-r">
                <SessionFilesSection
                  mode="all"
                  diffs={diffs()}
                  diffsReady={props.diffsReady}
                  canReview={props.canReview}
                  hasReview={props.hasReview}
                  activeDiff={props.activeDiff}
                  focusDiff={props.focusReviewDiff}
                  openFile={openFile}
                />
              </ScrollView>
              <div class="min-h-0 min-w-0 flex-1">
                <Show when={selectedFile()}>
                  {(path) => <FileTabContent tab={file.tab(path())} />}
                </Show>
              </div>
            </div>
          </TabsV2.Content>
        </TabsV2>
      </AppPage>
    </Show>
  )
}
