import { type Component } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { NotificationRowsV2 } from "./notifications-list"

/**
 * The full notification history, opened from Settings → Health's "All notifications" button.
 *
 * The Settings row shows the newest `RECENT_NOTIFICATIONS_LIMIT`; this shows everything the instance
 * still retains (`history.all()`), newest first, scrollable. It renders the SAME rows the preview
 * does, so "all" is a longer view of one list rather than a second rendering that can drift.
 */
export const DialogNotifications: Component = () => {
  const language = useLanguage()
  const notifications = useNotification()
  return (
    <Dialog size="content">
      <div class="flex max-h-[80vh] w-[34rem] max-w-[90vw] flex-col gap-3 overflow-y-auto px-6 py-6">
        <div class="flex flex-col gap-1">
          <span class="text-[15px] font-semibold text-v2-text-text-base">
            {language.t("settings.health.notifications.all")}
          </span>
          <span class="text-[12px] text-v2-text-text-muted">
            {language.t("settings.health.notifications.allDescription")}
          </span>
        </div>
        <NotificationRowsV2 entries={notifications.history.all()} />
      </div>
    </Dialog>
  )
}
