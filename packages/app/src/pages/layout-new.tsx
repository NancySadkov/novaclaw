import { createEffect, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useJumpToAttentionCommand } from "@/apps/jump-to-attention"
import { useSettingsCommand } from "@/components/settings-dialog"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const navigate = useNavigate()
  setNavigate(navigate)
  // Always-live from anywhere in the shell: mod+j → the chat that needs you (uix-improvement slice 3).
  useJumpToAttentionCommand()
  // Settings + log export register HERE so every route (incl. the launcher) resolves them — the
  // macOS menu bar and the palette depend on that. This must stay the only "settings"-key owner:
  // a second register() with the same key evicts this one and takes the key down when it unmounts.
  useSettingsCommand()
  command.register("shell", () =>
    platform.platform === "desktop" && platform.exportDebugLogs
      ? [
          {
            id: "logs.export",
            title: "Export logs",
            category: language.t("command.category.settings"),
            onSelect: () => {
              void platform.exportDebugLogs?.()
            },
          },
        ]
      : [],
  )

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar update={update} />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      {import.meta.env.DEV && <DebugBar inline />}
      {/* No floating HelpButton in the new layout — the Help app tile owns the tour (SP8; the old
          placeholder popover was dev-only lorem-ipsum competing with it). */}
      <ToastRegion v2 />
    </div>
  )
}
