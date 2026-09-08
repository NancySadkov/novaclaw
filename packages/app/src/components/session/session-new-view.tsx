import { Show, createMemo } from "solid-js"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Icon } from "@novaclaw/ui/v2/icon"
import { NovaClawWordmark } from "@/components/brand"
import { getDirectory, getFilename } from "@novaclaw/core/util/path"

const ROOT_CLASS = "size-full flex flex-col"

export function NewSessionView() {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()

  const projectRoot = createMemo(() => sdk().directory)

  // T3 (entities.md): no entity — the opened folder is the root, and sandboxes died with it. The
  // worktree PICKER died with them: this view carried `sandboxes` (a constant `[]`), an `options`
  // list built from it, an `isWorktree` that was a constant `false`, and `create`/filename arms that
  // no value could reach — `newSessionWorktree` in `pages/session.tsx` is seeded "main" and only ever
  // set back to "main". All that survived the folding is the branch line below. (, 2026-09-01)
  const branchLabel = createMemo(() => {
    const branch = sync().data.vcs?.branch
    return branch
      ? language.t("session.new.worktree.mainWithBranch", { branch })
      : language.t("session.new.worktree.main")
  })

  return (
    <div class={ROOT_CLASS}>
      <div class="h-12 shrink-0" aria-hidden />
      <div class="flex-1 px-6 pb-30 flex items-center justify-center text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center gap-4">
          <div class="flex flex-col items-center gap-6">
            <NovaClawWordmark class="text-[26px]" />
            <div class="text-20-medium text-text-strong">{language.t("session.new.title")}</div>
          </div>
          <div class="w-full flex flex-col gap-4 items-center">
            <div class="flex items-start justify-center gap-3 min-h-5">
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {getDirectory(projectRoot())}
                <span class="text-text-strong">{getFilename(projectRoot())}</span>
              </div>
            </div>
            <div class="flex items-start justify-center gap-1.5 min-h-5">
              <Icon name="branch" size="normal" class="mt-0.5 shrink-0" />
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {branchLabel()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
