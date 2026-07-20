import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Icon } from "@novaclaw/ui/icon"
import { useConfirm } from "@/components/dialog-confirm"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { showToast } from "@/utils/toast"
import {
  registryDeleteRow,
  registryInsertRow,
  registryRows,
  registryTables,
  registryUpdateRow,
  type RegistryRow,
} from "@/utils/registry-api"

// The Registry app (owner directive 2026-07-15) — a Regedit-style editor over the instance
// SQLite database. Developer expertise only (the home tile is minLevel-gated); this is the
// sanctioned re-homing of the raw `db` shell (todo.md tie-break #3: raw diagnostics live in
// Developer-mode apps, not terminal surfaces). Strings stay untranslated on purpose — a
// Developer-only diagnostic surface, like the debug bar.

const PAGE_SIZE = 100

// Tables whose rows ARE live configuration. MEASURED 2026-07-20: inserting a row with an unrecognised
// key into `runtime_setting` made the instance UNBOOTABLE — the config loader rejects unknown keys, so
// the server crash-looped until the row was deleted by hand. Inserting here needs eyes open.
const CONFIG_BACKED_TABLES = new Set(["runtime_setting"])
const NULL_LABEL = "∅ NULL"

function cellText(value: unknown): string {
  if (value === null || value === undefined) return NULL_LABEL
  return String(value)
}

export function RegistryPage() {
  const global = useGlobal()
  const server = useServer()
  const confirm = useConfirm()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const [tick, setTick] = createSignal(0)

  // The database is global; `directory` is only request routing — the server's home works.
  const [routeDir] = createResource(ctx, async (c) => {
    const p = c.sync.data.path
    if (p && (p.home || p.directory)) return p.home || p.directory
    const got = await c.sdk.client.path
      .get()
      .then((r) => r.data)
      .catch(() => undefined)
    return got?.home || got?.directory || ""
  })

  const [selected, setSelected] = createSignal<string | undefined>()
  const [offset, setOffset] = createSignal(0)
  const [editing, setEditing] = createSignal<RegistryRow | undefined>()
  const [creating, setCreating] = createSignal(false)
  const [draft, setDraft] = createStore<Record<string, string>>({})

  const [tables] = createResource(
    () => {
      const cn = conn()
      const d = routeDir()
      return cn && d ? { cn, d, t: tick() } : undefined
    },
    ({ cn, d }) => registryTables(cn.http, { directory: d }).catch(() => undefined),
  )

  const [page] = createResource(
    () => {
      const cn = conn()
      const d = routeDir()
      const table = selected()
      return cn && d && table ? { cn, d, table, offset: offset(), t: tick() } : undefined
    },
    ({ cn, d, table, offset }) =>
      registryRows(cn.http, { directory: d, table, limit: PAGE_SIZE, offset }).catch((error) => {
        showToast({ variant: "error", title: "Registry read failed", description: String(error) })
        return undefined
      }),
  )

  function openTable(name: string) {
    setSelected(name)
    setOffset(0)
    setEditing(undefined)
  }

  function openRow(row: RegistryRow) {
    setEditing(row)
    const next: Record<string, string> = {}
    for (const [column, value] of Object.entries(row.values)) next[column] = cellText(value)
    setDraft(reconcile(next))
  }

  function openNewRow() {
    setEditing(undefined)
    const next: Record<string, string> = {}
    for (const column of page()?.columns ?? []) next[column] = ""
    setDraft(reconcile(next))
    setCreating(true)
  }

  async function insertRow() {
    const cn = conn()
    const d = routeDir()
    const table = selected()
    if (!cn || !d || !table) return
    if (CONFIG_BACKED_TABLES.has(table)) {
      const proceed = await confirm({
        title: `Insert into ${table}?`,
        description:
          `Rows in ${table} are live configuration. An unrecognised key makes the instance fail to start ` +
          `(it crash-loops until the row is removed by hand). Only insert a key you know the config schema accepts.`,
        confirmLabel: "Insert anyway",
        destructive: true,
      })
      if (!proceed) return
    }
    // Blank fields are OMITTED rather than written as "": the column's DEFAULT (or NULL) is almost
    // always what you want on a hand-made row, and "" would defeat a NOT NULL default.
    const values: Record<string, unknown> = {}
    for (const column of page()?.columns ?? []) {
      const value = draft[column]
      if (value !== undefined && value !== "") values[column] = value
    }
    try {
      await registryInsertRow(cn.http, { directory: d, table, values })
    } catch (error) {
      // Constraint violations land here — show the database's own words, they are the useful part.
      showToast({ variant: "error", title: "Insert failed", description: String(error) })
      return
    }
    setCreating(false)
    setTick((t) => t + 1)
  }

  async function saveRow() {
    const cn = conn()
    const d = routeDir()
    const table = selected()
    const row = editing()
    if (!cn || !d || !table || !row) return
    // Send ONLY changed columns; a value left at the NULL label stays untouched.
    const values: Record<string, unknown> = {}
    for (const [column, original] of Object.entries(row.values)) {
      const edited = draft[column]
      if (edited === undefined || edited === cellText(original)) continue
      values[column] = edited
    }
    if (Object.keys(values).length === 0) {
      setEditing(undefined)
      return
    }
    try {
      await registryUpdateRow(cn.http, { directory: d, table, rowid: row.rowid, values })
    } catch (error) {
      showToast({ variant: "error", title: "Registry write failed", description: String(error) })
      return
    }
    setEditing(undefined)
    setTick((t) => t + 1)
  }

  async function deleteRow(row: RegistryRow) {
    const cn = conn()
    const d = routeDir()
    const table = selected()
    if (!cn || !d || !table) return
    const proceed = await confirm({
      title: "Delete row",
      description: `Permanently delete rowid ${row.rowid} from ${table}? Foreign-key cascades apply.`,
      confirmLabel: "Delete",
    })
    if (!proceed) return
    try {
      await registryDeleteRow(cn.http, { directory: d, table, rowid: row.rowid })
    } catch (error) {
      showToast({ variant: "error", title: "Registry delete failed", description: String(error) })
      return
    }
    setEditing(undefined)
    setTick((t) => t + 1)
  }

  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <div class="rounded-[10px] shadow-[var(--v2-elevation-raised)] m-2 min-h-0 overflow-hidden bg-v2-background-bg-base self-stretch flex-1 flex flex-col">
      <div class="flex items-center gap-2 border-b border-v2-border-border-base px-4 py-3">
        <Icon name="cpu" size="small" class="text-v2-icon-icon-muted" />
        <span class="text-[14px] font-semibold text-v2-text-text-base">Registry</span>
        <span class="text-[12px] text-v2-text-text-faint">
          the instance database, editable — changes are immediate and unguarded
        </span>
      </div>
      <div class="flex min-h-0 flex-1">
        <div class="w-56 shrink-0 overflow-y-auto border-r border-v2-border-border-base p-2">
          <For each={tables() ?? []}>
            {(table) => (
              <button
                type="button"
                data-component="registry-table"
                class="flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-left text-[12px] transition-colors"
                classList={{
                  "bg-v2-background-bg-layer-02 text-v2-text-text-base": selected() === table.name,
                  "text-v2-text-text-muted hover:bg-v2-background-bg-layer-01": selected() !== table.name,
                }}
                onClick={() => openTable(table.name)}
              >
                <span class="truncate font-mono">{table.name}</span>
                <span class="shrink-0 pl-2 tabular-nums text-v2-text-text-faint">{table.rowCount}</span>
              </button>
            )}
          </For>
        </div>
        <div class="min-w-0 flex-1 overflow-auto">
          <Show
            when={page()}
            fallback={
              <div class="p-6 text-[13px] text-v2-text-text-faint">
                {selected() ? "Loading…" : "Pick a table — hives on the left, rows here."}
              </div>
            }
          >
            {(current) => (
              <div class="flex min-h-full flex-col">
                <table class="w-full border-collapse text-[12px]">
                  <thead>
                    <tr class="sticky top-0 bg-v2-background-bg-base text-left text-v2-text-text-faint">
                      <th class="border-b border-v2-border-border-base px-2 py-1.5 font-medium">rowid</th>
                      <For each={[...current().columns]}>
                        {(column) => (
                          <th class="border-b border-v2-border-border-base px-2 py-1.5 font-mono font-medium">
                            {column}
                          </th>
                        )}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={[...current().rows]}>
                      {(row) => (
                        <tr
                          data-component="registry-row"
                          class="cursor-default transition-colors hover:bg-v2-background-bg-layer-01"
                          classList={{ "bg-v2-background-bg-layer-02": editing()?.rowid === row.rowid }}
                          onClick={() => openRow(row)}
                        >
                          <td class="border-b border-v2-border-border-muted px-2 py-1 tabular-nums text-v2-text-text-faint">
                            {row.rowid}
                          </td>
                          <For each={[...current().columns]}>
                            {(column) => (
                              <td class="max-w-[280px] truncate border-b border-v2-border-border-muted px-2 py-1 font-mono text-v2-text-text-muted">
                                {cellText(row.values[column])}
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <div class="flex items-center gap-2 px-2 py-2 text-[12px] text-v2-text-text-faint">
                  <button type="button" class={btn} disabled={offset() === 0} onClick={() => setOffset(Math.max(0, offset() - PAGE_SIZE))}>
                    ← Prev
                  </button>
                  <span class="tabular-nums">
                    {offset() + 1}–{Math.min(offset() + PAGE_SIZE, current().rowCount)} of {current().rowCount}
                  </span>
                  <button
                    type="button"
                    class={btn}
                    disabled={offset() + PAGE_SIZE >= current().rowCount}
                    onClick={() => setOffset(offset() + PAGE_SIZE)}
                  >
                    Next →
                  </button>
                  <button type="button" class={btn} onClick={openNewRow} disabled={!selected()}>
                    Add row
                  </button>
                </div>
                <Show when={creating()}>
                  <div data-component="registry-new-row" class="border-t border-v2-border-border-base p-3">
                    <div class="mb-2 flex items-center gap-2">
                      <span class="text-[12px] font-semibold text-v2-text-text-base">New row in {selected()}</span>
                      <Show when={CONFIG_BACKED_TABLES.has(selected() ?? "")}>
                        <span class="text-[11px] text-v2-state-fg-warning">
                          live config — an unknown key stops the instance booting
                        </span>
                      </Show>
                      <div class="flex-1" />
                      <button type="button" class={btn} onClick={() => void insertRow()}>
                        Insert
                      </button>
                      <button type="button" class={btn} onClick={() => setCreating(false)}>
                        Cancel
                      </button>
                    </div>
                    <div class="grid gap-2" style={{ "grid-template-columns": "minmax(120px, 200px) 1fr" }}>
                      <For each={page()?.columns ?? []}>
                        {(column) => (
                          <>
                            <div class="pt-1 font-mono text-[12px] text-v2-text-text-faint">{column}</div>
                            <textarea
                              rows={1}
                              data-registry-new-column={column}
                              class="min-h-7 w-full resize-y rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 font-mono text-[12px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
                              value={draft[column] ?? ""}
                              onInput={(event) => setDraft(column, event.currentTarget.value)}
                            />
                          </>
                        )}
                      </For>
                    </div>
                    <div class="pt-2 text-[11px] text-v2-text-text-faint">
                      Blank fields are left unset, so the column default (or NULL) applies.
                    </div>
                  </div>
                </Show>
                <Show when={editing()}>
                  {(row) => (
                    <div data-component="registry-editor" class="border-t border-v2-border-border-base p-3">
                      <div class="mb-2 flex items-center gap-2">
                        <span class="text-[12px] font-semibold text-v2-text-text-base">
                          Edit rowid {row().rowid}
                        </span>
                        <div class="flex-1" />
                        <button type="button" class={btn} onClick={() => void saveRow()}>
                          Save changes
                        </button>
                        <button type="button" class={btn} onClick={() => void deleteRow(row())}>
                          Delete row
                        </button>
                        <button type="button" class={btn} onClick={() => setEditing(undefined)}>
                          Close
                        </button>
                      </div>
                      <div class="grid gap-2" style={{ "grid-template-columns": "minmax(120px, 200px) 1fr" }}>
                        <For each={Object.keys(row().values)}>
                          {(column) => (
                            <>
                              <div class="pt-1 font-mono text-[12px] text-v2-text-text-faint">{column}</div>
                              <textarea
                                rows={1}
                                data-registry-column={column}
                                class="min-h-7 w-full resize-y rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 font-mono text-[12px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
                                value={draft[column] ?? ""}
                                onInput={(event) => setDraft(column, event.currentTarget.value)}
                              />
                            </>
                          )}
                        </For>
                      </div>
                      <div class="pt-2 text-[11px] text-v2-text-text-faint">
                        Only changed fields are written. A field left as “{NULL_LABEL}” stays untouched.
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
