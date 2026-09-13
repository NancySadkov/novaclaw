import { A } from "@solidjs/router"
import { For } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"

export interface WorkerListItem {
  readonly id: string
  readonly title?: string
}

/** One worker-list surface shared by All Officers and the chat-local activity shortcut. */
export function WorkerListDialog(props: {
  title: string
  workers: readonly WorkerListItem[]
  href: (sessionID: string) => string
}) {
  const dialog = useDialog()
  const language = useLanguage()
  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-h-[70vh] overflow-y-auto p-2">
        <For each={props.workers}>
          {(worker, index) => (
            <A
              href={props.href(worker.id)}
              onClick={() => dialog.close()}
              class="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-v2-background-bg-layer-02"
            >
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03 text-xs">
                {index() + 1}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">
                  {worker.title?.trim() || language.t("contacts.workers.untitled", { number: String(index() + 1) })}
                </span>
                <span class="block truncate text-[11px] text-v2-text-text-faint">
                  {language.t("contacts.workers.open")}
                </span>
              </span>
            </A>
          )}
        </For>
      </DialogBody>
    </Dialog>
  )
}
