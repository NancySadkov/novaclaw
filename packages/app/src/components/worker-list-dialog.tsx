import { A } from "@solidjs/router"
import { createSignal, For, Show } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { RunningFor } from "@/components/running-for"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export interface WorkerListItem {
  readonly id: string
  readonly title?: string
  readonly startedAt?: number
}

/** One worker-list surface shared by All Officers and the chat-local activity shortcut. */
export function WorkerListDialog(props: {
  title: string
  workers: readonly WorkerListItem[]
  href: (sessionID: string) => string
  onStop?: (worker: WorkerListItem, reason: string) => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [stopping, setStopping] = createSignal<string>()
  const [reason, setReason] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const stop = async (worker: WorkerListItem) => {
    const why = reason().trim()
    if (!props.onStop || !why) return
    setSaving(true)
    try {
      await props.onStop(worker, why)
      showToast({ variant: "success", title: language.t("contacts.workers.stopped") })
      // The worker leaves the list when its execution settles; the dialog stays open so another
      // one can be stopped without reopening it.
      setStopping(undefined)
      setReason("")
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("contacts.workers.stopFailed"),
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
        <Show when={props.workers.length === 0}>
          <p class="px-3 py-6 text-center text-xs text-v2-text-text-faint">
            {language.t("session.activity.workers.empty")}
          </p>
        </Show>
        <For each={props.workers}>
          {(worker, index) => (
            <div class="rounded-md px-3 py-2 hover:bg-v2-background-bg-layer-02">
              <div class="flex items-center gap-3">
                <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03 text-xs">
                  {index() + 1}
                </span>
                <A href={props.href(worker.id)} onClick={() => dialog.close()} class="min-w-0 flex-1">
                  <span class="block truncate text-sm">
                    {worker.title?.trim() || language.t("contacts.workers.untitled", { number: String(index() + 1) })}
                  </span>
                  <span class="block truncate text-[11px] text-v2-text-text-faint">
                    <RunningFor startedAt={worker.startedAt} />
                    <Show when={typeof worker.startedAt === "number"}> · </Show>
                    {language.t("contacts.workers.open")}
                  </span>
                </A>
                <Show when={props.onStop !== undefined}>
                  <button
                    type="button"
                    class="shrink-0 rounded-md px-2 py-1 text-xs text-v2-state-fg-danger hover:bg-v2-background-bg-layer-03"
                    onClick={() => {
                      setReason("")
                      setStopping((current) => (current === worker.id ? undefined : worker.id))
                    }}
                  >
                    {language.t("contacts.workers.stop")}
                  </button>
                </Show>
              </div>
              <Show when={stopping() === worker.id}>
                <div class="mt-2 border-t border-v2-border-border-muted pt-2">
                  <label class="block text-xs text-v2-text-text-muted">
                    {language.t("contacts.workers.stopReason")}
                    <textarea
                      autofocus
                      class="mt-1 min-h-20 w-full resize-y rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-2 text-sm text-v2-text-text-base"
                      value={reason()}
                      onInput={(event) => setReason(event.currentTarget.value)}
                      placeholder={language.t("contacts.workers.stopReasonPlaceholder")}
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
                      onClick={() => void stop(worker)}
                    >
                      {saving() ? language.t("contacts.workers.stopping") : language.t("contacts.workers.stop")}
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
