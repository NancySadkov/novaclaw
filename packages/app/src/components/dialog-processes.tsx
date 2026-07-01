import { Component, createMemo, For, Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useCommand } from "@/context/command"
import { useServerSync } from "@/context/server-sync"

// Processes ("ps") — a task-manager over the agent-session tree (architecture.md step 7 / the OS shell).
// Lists every LOADED session as a tree (by parentID = the process tree) with agent · model · status ·
// tokens, so the spawn/exit/wait lifecycle is visible. Reads the live server-session store (mirrors
// sidebar-project.tsx). Shows loaded sessions; a full `session.list` fetch (incl. unloaded children)
// + click-to-open + live refresh are follow-ups (Phase 2).

type Row = { session: Session; depth: number }

// Flatten the session forest into depth-ordered rows (a parent's children indented under it). A session
// whose parent isn't loaded is treated as a root so nothing is hidden.
function toRows(sessions: Session[]): Row[] {
  const ids = new Set(sessions.map((s) => s.id))
  const byParent = new Map<string | undefined, Session[]>()
  for (const s of sessions) {
    const key = s.parentID && ids.has(s.parentID) ? s.parentID : undefined
    const list = byParent.get(key) ?? []
    list.push(s)
    byParent.set(key, list)
  }
  const rows: Row[] = []
  const visit = (parent: string | undefined, depth: number) => {
    for (const s of (byParent.get(parent) ?? []).sort((a, b) => (a.id < b.id ? 1 : -1))) {
      rows.push({ session: s, depth })
      visit(s.id, depth + 1)
    }
  }
  visit(undefined, 0)
  return rows
}

export const DialogProcesses: Component = () => {
  const serverSync = useServerSync()

  const rows = createMemo(() => {
    const info = serverSync().session.data.info
    return toRows(Object.values(info).filter((s): s is Session => !!s))
  })

  const statusOf = (id: string): string => {
    if (serverSync().session.data.session_working(id)) return "busy"
    const raw = serverSync().session.data.session_status[id]?.type
    return raw && raw !== "idle" ? raw : "idle"
  }

  const tokensOf = (s: Session) => {
    const t = s.tokens
    return t ? (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) : 0
  }

  return (
    <Dialog size="large">
      <div class="flex flex-col gap-2 p-4 min-w-[40rem] max-h-[70vh]">
        <div class="flex items-center gap-2 pb-2 border-b border-border-weak-base">
          <Icon name="sliders" />
          <span class="text-14-medium text-text-strong grow">Processes (ps)</span>
          <span class="text-12-medium text-text-weak">{rows().length} session(s)</span>
        </div>
        <div class="flex items-center gap-3 px-2 pb-1 text-12-medium text-text-weak">
          <span class="grow min-w-0">Session</span>
          <span class="shrink-0 w-16">Agent</span>
          <span class="shrink-0 w-28">Model</span>
          <span class="shrink-0 w-14">Status</span>
          <span class="shrink-0 w-16 text-right">Tokens</span>
        </div>
        <div class="flex flex-col overflow-auto">
          <Show
            when={rows().length > 0}
            fallback={<div class="p-4 text-12-medium text-text-weak">No sessions loaded.</div>}
          >
            <For each={rows()}>
              {(row) => {
                const s = row.session
                const status = statusOf(s.id)
                return (
                  <div class="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-surface-base-hover text-14-medium">
                    <span
                      class="truncate grow min-w-0 text-text-base"
                      style={{ "padding-left": `${row.depth * 14}px` }}
                    >
                      {row.depth > 0 ? "└ " : ""}
                      {s.title || s.id}
                    </span>
                    <span class="shrink-0 w-16 text-12-medium text-text-weak truncate">{s.agent ?? "—"}</span>
                    <span class="shrink-0 w-28 text-12-medium text-text-weak truncate">{s.model?.id ?? "—"}</span>
                    <span
                      class="shrink-0 w-14 text-12-medium"
                      classList={{ "text-text-strong": status !== "idle", "text-text-weak": status === "idle" }}
                    >
                      {status}
                    </span>
                    <span class="shrink-0 w-16 text-right text-12-medium text-text-weak tabular-nums">{tokensOf(s)}</span>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

// Mirror `useSettingsCommand` (settings-dialog.tsx): register a command + keybind that opens the dialog.
// Call this from a mounted page (session.tsx) so the command is live.
export function useProcessesCommand() {
  const command = useCommand()
  const dialog = useDialog()
  const show = () => {
    void dialog.show(() => <DialogProcesses />)
  }
  command.register("processes", () => [
    {
      id: "processes.open",
      title: "Processes (ps)",
      category: "Session",
      keybind: "mod+shift+p",
      onSelect: show,
    },
  ])
  return show
}
