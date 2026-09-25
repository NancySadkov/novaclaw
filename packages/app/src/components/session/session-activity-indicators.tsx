import { createMemo, Show } from "solid-js"
import { createQuery } from "@tanstack/solid-query"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { ShellListDialog } from "@/components/shell-list-dialog"
import { WorkerListDialog } from "@/components/worker-list-dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { sessionHref } from "@/utils/session-route"
import { stopSessionCommand, stopSessionExecution } from "@/utils/session-execution-api"
import { useWorkers } from "@/context/workers"

function ActivityButton(props: {
  action: string
  icon: "branch" | "terminal"
  count: number
  label: string
  onClick: () => void
}) {
  return (
    <TooltipV2 placement="top" gutter={4} value={props.label}>
      <button
        type="button"
        data-action={props.action}
        class="flex h-7 items-center gap-1 rounded-md px-1.5 text-v2-icon-icon-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
        aria-label={props.label}
        onClick={props.onClick}
      >
        <Icon name={props.icon} class="size-3.5" />
        <span class="min-w-3 text-center text-[11px] font-medium tabular-nums">{props.count}</span>
      </button>
    </TooltipV2>
  )
}

/** Live shortcuts for work happening below the chat the user is currently reading. */
export function SessionActivityIndicators(props: { sessionID: string }) {
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const dialog = useDialog()
  const language = useLanguage()

  const workerQuery = useWorkers(() => props.sessionID)
  // The session cache is intentionally bounded and starts nearly empty after a restart. Worker
  // ownership is durable instance state, so this shortcut reads the server projection directly.
  const workers = createMemo(() => workerQuery.data ?? [])

  const shellQuery = createQuery(() => ({
    queryKey: ["session-running-shells", server.key, sdk().directory, props.sessionID],
    queryFn: async () => {
      const response = await sdk().client.v2.session.bash.list({ sessionID: props.sessionID })
      return response.data?.data ?? []
    },
    refetchInterval: 2_000,
  }))
  const shells = createMemo(() => shellQuery.data ?? [])
  const href = (sessionID: string) => sessionHref(server.key, sessionID)

  const openWorkers = () => {
    if (workers().length === 0) return
    void dialog.showScoped(() => (
      <WorkerListDialog
        title={language.t("session.activity.workers.title")}
        // The accessor, not a snapshot: a worker that settles while the dialog is open drops out.
        workers={workers()}
        href={href}
        onStop={async (worker, reason) => {
          const current = server.current
          if (!current) throw new Error("No instance is connected")
          await stopSessionExecution(current.http, worker.id, sdk().directory, reason)
          await workerQuery.refetch()
        }}
      />
    ))
  }

  const openShells = () => {
    if (shells().length === 0) return
    void dialog.showScoped(() => (
      <ShellListDialog
        title={language.t("session.activity.shells.title")}
        // The accessor, not a snapshot: a command that finishes while the dialog is open drops out.
        shells={shells()}
        href={href}
        owner={(sessionID) =>
          sync().session.get(sessionID)?.title?.trim() ||
          language.t(
            sessionID === props.sessionID ? "session.activity.shells.thisChat" : "session.activity.shells.workerChat",
          )
        }
        onStop={async (job, reason) => {
          const current = server.current
          if (!current) throw new Error("No instance is connected")
          await stopSessionCommand(current.http, job.sessionID, sdk().directory, job.id, reason)
          await shellQuery.refetch()
        }}
      />
    ))
  }

  return (
    <>
      <Show when={workers().length > 0}>
        <ActivityButton
          action="prompt-workers"
          icon="branch"
          count={workers().length}
          label={language.plural("session.activity.workers.count", workers().length)}
          onClick={openWorkers}
        />
      </Show>
      <Show when={shells().length > 0}>
        <ActivityButton
          action="prompt-shells"
          icon="terminal"
          count={shells().length}
          label={language.plural("session.activity.shells.count", shells().length)}
          onClick={openShells}
        />
      </Show>
    </>
  )
}
