import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import type { Notification } from "@/context/notification"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

/**
 * The notification history as a list — ONE renderer, two callers.
 *
 * 🔴 Settings → Health shows a bounded preview (`RECENT_NOTIFICATIONS_LIMIT`) and an "All
 * notifications" button; the button opens a dialog over the SAME rows. The row copy is shared rather
 * than duplicated so the preview and the full list can never disagree about how an error reads or
 * where the timestamp sits (owner, 2026-09-19: *"Recent notifications should be limited to last 5 and
 * All Notifications button"*).
 */
export const RECENT_NOTIFICATIONS_LIMIT = 5

const titleOf = (notification: Notification, language: ReturnType<typeof useLanguage>) => {
  if (notification.type === "toast")
    return notification.title || notification.description || language.t("settings.health.notifications.notice")
  if (notification.type === "error")
    return language.t("settings.health.notifications.error", { session: notification.session ?? "NovaClaw" })
  return language.t("settings.health.notifications.complete", { session: notification.session ?? "NovaClaw" })
}

const descriptionOf = (notification: Notification) =>
  notification.type === "toast" && notification.title
    ? notification.description
    : new Date(notification.time).toLocaleString()

export const NotificationRowV2: Component<{ readonly notification: Notification }> = (props) => {
  const language = useLanguage()
  return (
    <SettingsRowV2 title={titleOf(props.notification, language)} description={descriptionOf(props.notification)}>
      <span class="select-text text-[11px] text-v2-text-text-muted">
        {new Date(props.notification.time).toLocaleString()}
      </span>
    </SettingsRowV2>
  )
}

export const NotificationRowsV2: Component<{
  readonly entries: readonly Notification[]
  /** Show only the newest `limit` entries. Absent shows all — the dialog's behaviour. */
  readonly limit?: number
}> = (props) => {
  const language = useLanguage()
  const shown = () => (props.limit === undefined ? props.entries : props.entries.slice(0, props.limit))
  return (
    <SettingsListV2>
      <For each={shown()}>{(notification) => <NotificationRowV2 notification={notification} />}</For>
      <Show when={shown().length === 0}>
        <SettingsRowV2
          title={language.t("settings.health.notifications.empty")}
          description={language.t("settings.health.notifications.emptyDescription")}
        >
          <span />
        </SettingsRowV2>
      </Show>
    </SettingsListV2>
  )
}
