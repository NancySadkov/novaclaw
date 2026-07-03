import { Component, createMemo, For, Show } from "solid-js"
import type { Session } from "@novaclaw/sdk/v2/client"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"
import { useServerSync } from "@/context/server-sync"

// Processes — a friendly "what your agents are doing right now" activity view over the agent-session
// tree (architecture.md step 7 / the OS shell). For everyone it reads as a plain activity list with a
// status pill; the developer detail (raw model ids + token counts) is gated to Developer (uix.md §6.4 /
// SP1). Reads the live server-session store (mirrors sidebar-project.tsx); v2 tokens, i18n'd.

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

// Raw status → a friendly, plain-language label + a status-pill tone. Unknown states read as "Ready".
const STATUS: Record<string, { key: string; tone: "working" | "waiting" | "done" | "ready" }> = {
  busy: { key: "processes.status.working", tone: "working" },
  working: { key: "processes.status.working", tone: "working" },
  idle: { key: "processes.status.ready", tone: "ready" },
  waiting: { key: "processes.status.waiting", tone: "waiting" },
  blocked: { key: "processes.status.waiting", tone: "waiting" },
  paused: { key: "processes.status.paused", tone: "waiting" },
  exited: { key: "processes.status.done", tone: "done" },
  done: { key: "processes.status.done", tone: "done" },
}

export const DialogProcesses: Component = () => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const { atLeast } = useExpertise()
  const developer = () => atLeast("developer")

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

  const status = (id: string) => STATUS[statusOf(id)] ?? { key: "processes.status.ready", tone: "ready" as const }

  return (
    <Dialog size="large">
      <div class="flex flex-col gap-2 p-4 min-w-[36rem] max-h-[70vh]">
        <div class="flex items-center gap-2 pb-2 border-b border-v2-border-border-base">
          <Icon name="status" size="small" class="text-v2-icon-icon-muted" />
          <span class="text-[15px] font-semibold text-v2-text-text-base grow">{language.t("processes.title")}</span>
          <span class="text-xs font-medium text-v2-text-text-faint">
            {rows().length > 0
              ? language.t("processes.running", { count: rows().length })
              : language.t("processes.empty")}
          </span>
        </div>
        <div class="flex flex-col overflow-auto">
          <Show
            when={rows().length > 0}
            fallback={<div class="p-6 text-center text-sm text-v2-text-text-faint">{language.t("processes.empty")}</div>}
          >
            <For each={rows()}>
              {(row) => {
                const s = row.session
                const st = status(s.id)
                return (
                  <div class="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-v2-background-bg-layer-02">
                    <div class="flex min-w-0 grow flex-col" style={{ "padding-left": `${row.depth * 14}px` }}>
                      <span class="truncate text-sm text-v2-text-text-base">
                        {row.depth > 0 ? "└ " : ""}
                        {s.title || language.t("processes.untitled")}
                      </span>
                      <Show when={developer()}>
                        <span class="truncate text-[11px] font-mono text-v2-text-text-faint">
                          {s.agent ?? "—"} · {s.model?.id ?? "—"} · {language.t("processes.tokens", { count: tokensOf(s) })}
                        </span>
                      </Show>
                    </div>
                    <span
                      class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                      classList={{
                        "bg-v2-state-bg-info text-v2-state-fg-info": st.tone === "working",
                        "bg-v2-state-bg-warning text-v2-state-fg-warning": st.tone === "waiting",
                        "bg-v2-state-bg-success text-v2-state-fg-success": st.tone === "done",
                        "text-v2-text-text-faint": st.tone === "ready",
                      }}
                    >
                      {language.t(st.key as Parameters<typeof language.t>[0])}
                    </span>
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
  const language = useLanguage()
  const show = () => {
    void dialog.show(() => <DialogProcesses />)
  }
  command.register("processes", () => [
    {
      id: "processes.open",
      title: language.t("processes.title"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+m", // NOT mod+shift+p — that's the command palette (command.tsx DEFAULT_PALETTE_KEYBIND)
      onSelect: show,
    },
  ])
  return show
}
