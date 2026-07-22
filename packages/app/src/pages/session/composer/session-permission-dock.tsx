import { For, Show, createSignal } from "solid-js"
import type { PermissionV2Request } from "@novaclaw/sdk/v2"
import { Button } from "@novaclaw/ui/button"
import { DockPrompt } from "@novaclaw/session-ui/dock-prompt"
import { Icon } from "@novaclaw/ui/icon"
import { useLanguage } from "@/context/language"

/** 1K: the six verdict-scope replies the dock can send (deny reasons ride `message`). */
export type PermissionReply = "allow-once" | "allow-file" | "allow-always" | "deny-once" | "deny-file" | "deny-always"

export function SessionPermissionDock(props: {
  request: PermissionV2Request
  responding: boolean
  onDecide: (reply: PermissionReply, message?: string) => void
  /** Stop the whole run (the ask-flood escape hatch) — interrupts; the orphaned asks then clear. */
  onStop?: () => void
}) {
  const language = useLanguage()
  const [reason, setReason] = createSignal("")

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const decide = (reply: PermissionReply) => {
    const message = reply.startsWith("deny") ? reason().trim() || undefined : undefined
    props.onDecide(reply, message)
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
          <Show when={props.onStop}>
            {(onStop) => (
              <Button
                variant="ghost"
                size="normal"
                class="ml-auto shrink-0"
                data-action="permission-stop-run"
                onClick={() => onStop()()}
              >
                <Icon name="stop" size="small" />
                {language.t("ui.permission.stopRun")}
              </Button>
            )}
          </Show>
        </div>
      }
      footer={
        <div data-slot="permission-footer-stack">
          <input
            data-slot="permission-reason-input"
            type="text"
            value={reason()}
            placeholder={language.t("ui.permission.reason.placeholder")}
            disabled={props.responding}
            onInput={(e) => setReason(e.currentTarget.value)}
          />
          <div data-slot="permission-footer-rows">
            <div data-slot="permission-footer-actions" data-variant="deny">
              <Button variant="ghost" size="normal" onClick={() => decide("deny-once")} disabled={props.responding}>
                {language.t("ui.permission.denyOnce")}
              </Button>
              <Button variant="ghost" size="normal" onClick={() => decide("deny-file")} disabled={props.responding}>
                {language.t("ui.permission.denyFile")}
              </Button>
              <Button variant="ghost" size="normal" onClick={() => decide("deny-always")} disabled={props.responding}>
                {language.t("ui.permission.denyAlways")}
              </Button>
            </div>
            <div data-slot="permission-footer-actions" data-variant="allow">
              <Button
                variant="secondary"
                size="normal"
                onClick={() => decide("allow-file")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowFile")}
              </Button>
              <Button
                variant="secondary"
                size="normal"
                onClick={() => decide("allow-always")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowAlways")}
              </Button>
              <Button variant="primary" size="normal" onClick={() => decide("allow-once")} disabled={props.responding}>
                {language.t("ui.permission.allowOnce")}
              </Button>
            </div>
          </div>
        </div>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.resources}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
