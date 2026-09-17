import { A } from "@solidjs/router"
import { createSignal, For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import type { SessionBashJob } from "@novaclaw/sdk/v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { RunningFor } from "@/components/running-for"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

/**
 * The background commands a chat (and its worker tree) is still running.
 *
 * The list hands the stop endpoint the job id — the identity the user sees and the model itself uses
 * (`{"job": "<id>", "action": "stop"}`). The endpoint accepts it alongside the tool-call id, because
 * an in-flight transcript card only knows the latter.
 */
export function ShellListDialog(props: {
  title: string
  shells: readonly SessionBashJob[]
  href: (sessionID: string) => string
  owner: (sessionID: string) => string
  onStop?: (job: SessionBashJob, reason: string) => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [stopping, setStopping] = createSignal<string>()
  const [reason, setReason] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const stop = async (job: SessionBashJob) => {
    const why = reason().trim()
    if (!props.onStop || !why) return
    setSaving(true)
    try {
      await props.onStop(job, why)
      showToast({ variant: "success", title: language.t("session.activity.shells.stopped") })
      // The row leaves the list when the query refreshes; the dialog stays open so a second heavy
      // command can be stopped without reopening it.
      setStopping(undefined)
      setReason("")
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("session.activity.shells.stopFailed"),
        description: String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-h-[70vh] overflow-y-auto p-2">
        <Show when={props.shells.length === 0}>
          <p class="px-3 py-6 text-center text-xs text-v2-text-text-faint">
            {language.t("session.activity.shells.empty")}
          </p>
        </Show>
        <For each={props.shells}>
          {(job) => (
            <div class="rounded-md px-3 py-2 hover:bg-v2-background-bg-layer-02">
              <div class="flex items-start gap-3">
                <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03">
                  <Icon name="terminal" class="size-3.5" />
                </span>
                <A href={props.href(job.sessionID)} onClick={() => dialog.close()} class="min-w-0 flex-1">
                  <code class="block line-clamp-2 break-all text-[12px] leading-4 text-v2-text-text-base">
                    {job.command}
                  </code>
                  <span class="mt-0.5 block truncate text-[11px] text-v2-text-text-faint">
                    {props.owner(job.sessionID)} · <RunningFor startedAt={job.startedAt} />
                  </span>
                </A>
                <Show when={props.onStop !== undefined}>
                  <button
                    type="button"
                    class="shrink-0 rounded-md px-2 py-1 text-xs text-v2-state-fg-danger hover:bg-v2-background-bg-layer-03"
                    onClick={() => {
                      setReason("")
                      setStopping((current) => (current === job.id ? undefined : job.id))
                    }}
                  >
                    {language.t("session.activity.shells.stop")}
                  </button>
                </Show>
              </div>
              <Show when={stopping() === job.id}>
                <div class="mt-2 border-t border-v2-border-border-muted pt-2">
                  <label class="block text-xs text-v2-text-text-muted">
                    {language.t("session.activity.shells.stopReason")}
                    <textarea
                      autofocus
                      class="mt-1 min-h-20 w-full resize-y rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-2 text-sm text-v2-text-text-base"
                      value={reason()}
                      onInput={(event) => setReason(event.currentTarget.value)}
                      placeholder={language.t("session.activity.shells.stopReasonPlaceholder")}
                    />
                  </label>
                  <div class="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      class="rounded-md px-2.5 py-1.5 text-xs text-v2-text-text-muted hover:bg-v2-background-bg-layer-03"
                      onClick={() => setStopping(undefined)}
                    >
                      {language.t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      class="rounded-md bg-v2-state-bg-danger px-2.5 py-1.5 text-xs text-v2-state-fg-danger disabled:opacity-40"
                      disabled={!reason().trim() || saving()}
                      onClick={() => void stop(job)}
                    >
                      {saving()
                        ? language.t("session.activity.shells.stopping")
                        : language.t("session.activity.shells.stop")}
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </For>
      </DialogBody>
    </Dialog>
  )
}
