import { A } from "@solidjs/router"
import { createMemo, For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { useGlobal } from "@/context/global"
import { useServer, ServerConnection } from "@/context/server"
import type { ServerStreamStatus } from "@/context/server-sdk"
import { sessionHref } from "@/utils/session-route"
import { clearErrorLog, errorLogEntries } from "@/utils/error-log"
import { showToast } from "@/utils/toast"

// The Debug app (dependability P5) — the Developer-mode diagnostic surface. Four read-only panels,
// all fed from state the client ALREADY holds (no new server routes in v0): connection status per
// server, the client error ring buffer, a `ps`-lite over the cached sessions, and the config
// snapshot. Strings stay untranslated on purpose — a Developer-only surface, like Registry.

const STATUS_TONE: Record<ServerStreamStatus, string> = {
  connected: "text-v2-state-fg-success",
  connecting: "text-v2-text-text-muted",
  reconnecting: "text-v2-state-fg-warning",
  idle: "text-v2-text-text-faint",
}

const PS_LIMIT = 100

export function DebugPage() {
  const global = useGlobal()
  const server = useServer()

  const servers = createMemo(() => global.servers.list())
  const focused = createMemo(() => server.current ?? servers()[0])

  const sessions = createMemo(() => {
    const conn = focused()
    if (!conn) return []
    const ctx = global.ensureServerCtx(conn)
    const key = ServerConnection.key(conn)
    const info = ctx.sync.session.data.info
    const status = ctx.sync.session.data.session_status
    const rows = Object.values(info)
      .filter((s) => s !== undefined)
      .map((s) => ({
        id: s.id,
        title: s.title,
        agent: s.agent,
        parentID: s.parentID,
        status: status[s.id]?.type ?? "idle",
        href: sessionHref(key, s.id),
      }))
    // working first, then newest ids first (ids are time-sortable)
    return rows.sort((a, b) => Number(b.status !== "idle") - Number(a.status !== "idle") || (a.id < b.id ? 1 : -1))
  })

  const config = createMemo(() => {
    const conn = focused()
    if (!conn) return ""
    try {
      return JSON.stringify(global.ensureServerCtx(conn).sync.data.config, null, 2)
    } catch {
      return "<config unavailable>"
    }
  })

  const copyLog = () => {
    const text = errorLogEntries()
      .map((e) => `${new Date(e.at).toISOString()} [${e.level}] ${e.text}`)
      .join("\n")
    void navigator.clipboard
      .writeText(text || "(empty)")
      .then(() => showToast({ title: "Error log copied" }))
      .catch(() => showToast({ variant: "error", title: "Copy failed" }))
  }

  const section = "border-b border-v2-border-border-base"
  const heading = "flex items-center gap-2 px-4 pt-3 pb-2"
  const title = "text-[13px] font-semibold text-v2-text-text-base"
  const hint = "text-[11px] text-v2-text-text-faint"
  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <div class="rounded-[10px] shadow-[var(--v2-elevation-raised)] m-2 min-h-0 overflow-hidden bg-v2-background-bg-base self-stretch flex-1 flex flex-col">
      <div class="flex items-center gap-2 border-b border-v2-border-border-base px-4 py-3">
        <Icon name="console" size="small" class="text-v2-icon-icon-muted" />
        <span class="text-[14px] font-semibold text-v2-text-text-base">Debug</span>
        <span class="text-[12px] text-v2-text-text-faint">client-side diagnostics — read-only</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        {/* ── Connection ─────────────────────────────────────────────────────────────── */}
        <div class={section}>
          <div class={heading}>
            <span class={title}>Connection</span>
            <span class={hint}>SSE stream status per configured server</span>
          </div>
          <div class="px-4 pb-3">
            <Show when={servers().length > 0} fallback={<div class={hint}>no servers configured</div>}>
              <For each={servers()}>
                {(conn) => {
                  const ctx = global.ensureServerCtx(conn)
                  return (
                    <div class="flex items-center gap-3 py-1 text-[12px]">
                      <span class={`w-24 shrink-0 font-medium ${STATUS_TONE[ctx.sdk.streamStatus()]}`}>
                        {ctx.sdk.streamStatus()}
                      </span>
                      <span class="truncate font-mono text-v2-text-text-muted">{conn.http.url}</span>
                      <Show when={focused() === conn}>
                        <span class={hint}>(active)</span>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
        </div>

        {/* ── Error log ──────────────────────────────────────────────────────────────── */}
        <div class={section}>
          <div class={heading}>
            <span class={title}>Error log</span>
            <span class={hint}>
              uncaught errors, rejections, console error/warn — newest first, last {200} kept
            </span>
            <span class="flex-1" />
            <button type="button" class={btn} onClick={copyLog} disabled={errorLogEntries().length === 0}>
              <Icon name="copy" size="small" class="mr-1 inline-block align-[-2px]" />
              Copy
            </button>
            <button type="button" class={btn} onClick={clearErrorLog} disabled={errorLogEntries().length === 0}>
              Clear
            </button>
          </div>
          <div class="max-h-72 overflow-y-auto px-4 pb-3">
            <Show when={errorLogEntries().length > 0} fallback={<div class={hint}>nothing captured this session</div>}>
              <For each={[...errorLogEntries()].reverse()}>
                {(entry) => (
                  <div class="flex gap-2 py-0.5 text-[11px] leading-4">
                    <span class="shrink-0 tabular-nums text-v2-text-text-faint">
                      {new Date(entry.at).toLocaleTimeString()}
                    </span>
                    <span
                      class="w-14 shrink-0 font-medium"
                      classList={{
                        "text-v2-state-fg-danger": entry.level === "error" || entry.level === "uncaught",
                        "text-v2-state-fg-warning": entry.level === "warn",
                        "text-v2-text-text-muted": entry.level === "rejection",
                      }}
                    >
                      {entry.level}
                    </span>
                    <span class="min-w-0 whitespace-pre-wrap break-all font-mono text-v2-text-text-muted">
                      {entry.text}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        {/* ── Sessions (ps-lite) ─────────────────────────────────────────────────────── */}
        <div class={section}>
          <div class={heading}>
            <span class={title}>Sessions</span>
            <span class={hint}>
              ps-lite over the {sessions().length} cached session{sessions().length === 1 ? "" : "s"} (client cache,
              not the full database)
            </span>
          </div>
          <div class="max-h-72 overflow-y-auto px-4 pb-3">
            <Show when={sessions().length > 0} fallback={<div class={hint}>no sessions cached yet</div>}>
              <table class="w-full border-collapse text-[11px]">
                <thead>
                  <tr class="text-left text-v2-text-text-faint">
                    <th class="py-1 pr-2 font-medium">id</th>
                    <th class="py-1 pr-2 font-medium">status</th>
                    <th class="py-1 pr-2 font-medium">agent</th>
                    <th class="py-1 pr-2 font-medium">parent</th>
                    <th class="py-1 font-medium">title</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={sessions().slice(0, PS_LIMIT)}>
                    {(row) => (
                      <tr class="align-top">
                        <td class="py-0.5 pr-2 font-mono">
                          <A href={row.href} class="text-v2-text-text-muted hover:underline">
                            {row.id}
                          </A>
                        </td>
                        <td
                          class="py-0.5 pr-2"
                          classList={{
                            "text-v2-state-fg-success": row.status !== "idle",
                            "text-v2-text-text-faint": row.status === "idle",
                          }}
                        >
                          {row.status}
                        </td>
                        <td class="py-0.5 pr-2 text-v2-text-text-muted">{row.agent}</td>
                        <td class="py-0.5 pr-2 font-mono text-v2-text-text-faint">{row.parentID ?? "—"}</td>
                        <td class="max-w-64 truncate py-0.5 text-v2-text-text-muted">{row.title}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={sessions().length > PS_LIMIT}>
                <div class={hint}>+{sessions().length - PS_LIMIT} more not shown</div>
              </Show>
            </Show>
          </div>
        </div>

        {/* ── Config snapshot ────────────────────────────────────────────────────────── */}
        <div>
          <div class={heading}>
            <span class={title}>Config snapshot</span>
            <span class={hint}>the active server's resolved config (read-only — edit in Settings)</span>
          </div>
          <pre class="overflow-x-auto px-4 pb-4 font-mono text-[11px] leading-4 text-v2-text-text-muted">
            {config()}
          </pre>
        </div>
      </div>
    </div>
  )
}
