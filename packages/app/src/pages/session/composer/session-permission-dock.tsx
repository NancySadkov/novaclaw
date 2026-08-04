import { For, Show, createSignal } from "solid-js"
import type { PermissionV2Request } from "@novaclaw/sdk/v2"
import { Button } from "@novaclaw/ui/button"
import { DockPrompt } from "@novaclaw/session-ui/dock-prompt"
import { Icon } from "@novaclaw/ui/icon"
import { dynamicKey, useLanguage } from "@/context/language"
import { permissionOtherResources, permissionTargets } from "./session-permission-dock-domain"

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
    // ⚠️ Genuinely unchecked, and correctly so: `action` is a tool name off the wire (MCP and
    // plugin tools are registered at runtime), so there is no compile-time set to narrow to. The
    // missing-key case is HANDLED two lines down — a key that does not resolve renders nothing
    // rather than reaching the user as raw text.
    const key = `settings.permissions.tool.${props.request.action}.description`
    const value = language.t(dynamicKey(key))
    if (value === key) return ""
    return value
  }

  const decide = (reply: PermissionReply) => {
    const message = reply.startsWith("deny") ? reason().trim() || undefined : undefined
    props.onDecide(reply, message)
  }

  const targets = () => permissionTargets(props.request)
  const resources = () => permissionOtherResources(props.request)

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
      <Show when={targets().length > 0}>
        <div data-slot="permission-row" data-variant="targets">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={targets()}>
              {(target) => <code class="text-12-regular text-text-base break-all">{target}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={resources().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={resources()}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
