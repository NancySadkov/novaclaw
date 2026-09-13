import { A } from "@solidjs/router"
import { For } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@novaclaw/ui/v2/dialog-v2"
import type { SessionBashJob } from "@novaclaw/sdk/v2"
import { messageTime } from "@novaclaw/session-ui/v2/message-time"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"

export function ShellListDialog(props: {
  title: string
  shells: SessionBashJob[]
  href: (sessionID: string) => string
  owner: (sessionID: string) => string
}) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog size="normal" fit>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-h-[70vh] overflow-y-auto p-2">
        <For each={props.shells}>
          {(job) => {
            const started = () => messageTime({ created: job.startedAt, locale: language.locale() })?.label ?? ""
            return (
              <A
                href={props.href(job.sessionID)}
                onClick={() => dialog.close()}
                class="flex items-start gap-3 rounded-md px-3 py-2 hover:bg-v2-background-bg-layer-02"
              >
                <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-layer-03">
                  <Icon name="terminal" class="size-3.5" />
                </span>
                <span class="min-w-0 flex-1">
                  <code class="block line-clamp-2 break-all text-[12px] leading-4 text-v2-text-text-base">
                    {job.command}
                  </code>
                  <span class="mt-0.5 block truncate text-[11px] text-v2-text-text-faint">
                    {props.owner(job.sessionID)} · {language.t("session.activity.shells.started", { time: started() })}
                  </span>
                </span>
              </A>
            )
          }}
        </For>
      </DialogBody>
    </Dialog>
  )
}
