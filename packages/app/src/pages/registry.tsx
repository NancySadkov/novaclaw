import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
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
import { AppPage, AppPageHeader } from "@/components/app-page"
import { ExpertiseGate } from "@/components/expertise-gate"
import { RequiresLevel } from "@/context/expertise"
import { useLanguage } from "@/context/language"
import { resolveInstanceGlobalDirectory } from "@/utils/routing-directory"
import { answeredNothing, createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"

// The Registry app (owner directive 2026-07-15) — a Regedit-style editor over the instance
// SQLite database. Developer expertise only — gated on the ROUTE below, not merely on the home
// tile; this is the sanctioned re-homing of the raw `db` shell (todo.md tie-break #3: raw
// diagnostics live in Developer-mode apps, not terminal surfaces). Strings inside the app stay
// untranslated on purpose — a Developer-only diagnostic surface, like the debug bar — but the gate
// is read only by users who are NOT developers, so it speaks their language.

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

/**
 * The four things the panels can say. Exported because a render test asserting *"the rail named the
 * failure"* has to assert the SENTENCE a person reads, and a test carrying its own copy of the
 * sentence passes the day the screen's copy changes.
 *
 * ⚠️ No one of these may be a substring of another. The whole point is that a screen saying *the read
 * failed* and a screen saying *there is nothing* are distinguishable by looking at them, and an
 * assertion that one is absent has to be able to fail.
 */
export const REGISTRY_COPY = {
  tablesFailed: "Could not read the table list — the database did not answer.",
  tablesEmpty: "This database has no tables.",
  tablesLoading: "Reading tables…",
  rowsFailed: "Could not read these rows — the query did not answer.",
} as const

/**
 * 🔴 **A draft belongs to the form that owns it, and a form belongs to the table it was opened on.**
 *
 * The two editors here — *New row* and *Edit rowid N* — used to be two independent booleans over
 * ONE `draft` store, and only the "new" transition cleared the other. So clicking **Add row**, then
 * clicking an existing row to check a column name, left both forms mounted over the same keys with
 * the clicked row's values just `reconcile`d over whatever had been typed: editing either edited
 * both, and pressing **Insert** wrote a duplicate of the row the user had opened to look at. On
 * `runtime_setting` that is an instance that will not boot (see CONFIG_BACKED_TABLES above). The
 * second facet was the same shape one level out: `openTable` left the insert form up, so its columns
 * belonged to the previous table while its heading named the new one.
 *
 * ⚠️ **The fix is IDENTITY, not another `setCreating(false)`.** A clear-the-other-one call is a step
 * every future transition has to remember, and forgetting it is exactly what this bug was — the
 * remedy would have the same shape as the defect. So:
 *
 * - **each form carries the store it was opened with**, created at that moment, so there is no
 *   shared mutable value for two forms to disagree about. Neither can reach the other's text.
 * - **each form carries its own `table`, and is only rendered while that table is the selected
 *   one**, so a form cannot outlive its subject and `openTable` has nothing to remember.
 *
 * Both facets stop being handled and start being unwriteable. What survives on purpose: a half-typed
 * insert is still there when you come back to that table, because nothing threw it away.
 */
interface RegistryDraft {
  readonly table: string
  readonly columns: readonly string[]
  readonly draft: Record<string, string>
  readonly setDraft: SetStoreFunction<Record<string, string>>
}
type NewRowForm = RegistryDraft
type EditRowForm = RegistryDraft & { readonly row: RegistryRow }

/** A fresh store per form: the draft is created with the form and cannot be reached from elsewhere. */
function formDraft(values: Record<string, string>) {
  const [draft, setDraft] = createStore<Record<string, string>>(values)
  return { draft, setDraft }
}

// ── the ROUTE gate ────────────────────────────────────────────────────────────────────────────────
//
// `minLevel: "developer"` on the home tile hides the ICON and nothing else. Measured 2026-08-19 in
// the running web app: at `general.expertiseLevel = "normal"` the tile was correctly gone from the
// home screen while `/registry` still rendered the full table browser over the live instance
// database — where a delete is immediate and unguarded, and one bad `runtime_setting` row makes the
// instance unbootable (see CONFIG_BACKED_TABLES above). The gate belongs on the route.
//
// It explains rather than redirecting (principle 8; `app-routes.test.ts` pins the shape), and the
// outer/inner split keeps `RegistryPage` from opening the table list and the row resource for a user
// who may not see them.
export function RegistryPage() {
  const language = useLanguage()
  return (
    <RequiresLevel
      min="developer"
      fallback={
        <AppPage class="flex">
          <ExpertiseGate
            glyph="registry"
            title={language.t("home.app.registry.name")}
            description={language.t("registry.gate.description")}
          />
        </AppPage>
      }
    >
      <RegistryAppPage />
    </RequiresLevel>
  )
}

function RegistryAppPage() {
  const global = useGlobal()
  const server = useServer()
  const confirm = useConfirm()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const [tick, setTick] = createSignal(0)

  // The database is global; `directory` is only request routing — the server's home works. The read
  // itself is `utils/routing-directory.ts`, shared verbatim with trash.tsx and terminal.tsx.
  const [routeDir, routeDirActions] = createSettledResource(ctx, resolveInstanceGlobalDirectory)

  /**
   * ⚠️ A failed `GET /path` and an instance that answered with no folder at all are the same dead
   * end for this page — nothing can be routed either way — and neither is an empty database. Both
   * have to become the RAIL's failure, or the panel keyed on the directory sits at "not asked"
   * forever behind a spinner nothing will resolve.
   */
  const routingFailed = createMemo(() => routeDir.failed || answeredNothing(routeDir))

  const [selected, setSelected] = createSignal<string | undefined>()
  const [offset, setOffset] = createSignal(0)
  // Two forms, two stores, no shared value between them — see {@link RegistryDraft}.
  const [newForm, setNewForm] = createSignal<NewRowForm | undefined>()
  const [editForm, setEditForm] = createSignal<EditRowForm | undefined>()
  /** A form is only on screen while its own table is selected; that is the whole of `openTable`. */
  const newRowForm = createMemo(() => {
    const form = newForm()
    return form && form.table === selected() ? form : undefined
  })
  const editRowForm = createMemo(() => {
    const form = editForm()
    return form && form.table === selected() ? form : undefined
  })

  // 🔴 No `.catch` in either fetcher, here or below. A fetcher that swallows its own rejection hands
  // the caller the `undefined` an unasked read produces, and the rail then cannot tell "no tables"
  // from "no answer" — which is exactly what it used to render as a blank 224px column.
  const [tables, tablesActions] = createSettledResource(
    () => {
      const cn = conn()
      const d = routeDir()
      return cn && d ? { cn, d, t: tick() } : undefined
    },
    ({ cn, d }) => registryTables(cn.http, { directory: d }),
  )
  const tableList = createListState(tables, { failedWhen: routingFailed })
  const tableRows = createMemo(() => {
    const state = tableList()
    return state.kind === "loaded" ? state.items : undefined
  })

  const [page, pageActions] = createSettledResource(
    () => {
      const cn = conn()
      const d = routeDir()
      const table = selected()
      return cn && d && table ? { cn, d, table, offset: offset(), t: tick() } : undefined
    },
    ({ cn, d, table, offset }) => registryRows(cn.http, { directory: d, table, limit: PAGE_SIZE, offset }),
  )
  // The row read used to name its fault in a TOAST, which is gone within seconds and leaves the pane
  // saying "Loading…" underneath it. It is named in the pane instead, where it stays put and can be
  // retried; a transient notice is not how an unavailable subsystem names itself.
  const rowsFailed = createMemo(() => Boolean(selected()) && (page.failed || routingFailed()))

  // ⚠️ It does NOT close the two forms. It does not have to: each is gated on its own table above,
  // which is what makes "an insert form whose columns belong to the previous table" impossible to
  // render rather than something this function must remember to prevent.
  function openTable(name: string) {
    setSelected(name)
    setOffset(0)
  }

  function openRow(row: RegistryRow) {
    const table = selected()
    if (!table) return
    const values: Record<string, string> = {}
    for (const [column, value] of Object.entries(row.values)) values[column] = cellText(value)
    setEditForm({ table, row, columns: Object.keys(row.values), ...formDraft(values) })
  }

  function openNewRow() {
    const table = selected()
    if (!table) return
    const columns = [...(page()?.columns ?? [])]
    const values: Record<string, string> = {}
    for (const column of columns) values[column] = ""
    setNewForm({ table, columns, ...formDraft(values) })
  }

  async function insertRow(form: NewRowForm) {
    const cn = conn()
    const d = routeDir()
    // The table the FORM was opened on, never whatever is selected now — a form belongs to its own
    // subject for the same reason its draft does.
    const table = form.table
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
    for (const column of form.columns) {
      const value = form.draft[column]
      if (value !== undefined && value !== "") values[column] = value
    }
    try {
      await registryInsertRow(cn.http, { directory: d, table, values })
    } catch (error) {
      // Constraint violations land here — show the database's own words, they are the useful part.
      showToast({ variant: "error", title: "Insert failed", description: String(error) })
      return
    }
    setNewForm(undefined)
    setTick((t) => t + 1)
  }

  async function saveRow(form: EditRowForm) {
    const cn = conn()
    const d = routeDir()
    // The form's own table and row, never `selected()` — a write belongs to the subject the form was
    // opened on, which is the same rule that keeps its draft its own.
    const table = form.table
    const row = form.row
    if (!cn || !d) return
    // Send ONLY changed columns; a value left at the NULL label stays untouched.
    const values: Record<string, unknown> = {}
    for (const [column, original] of Object.entries(row.values)) {
      const edited = form.draft[column]
      if (edited === undefined || edited === cellText(original)) continue
      values[column] = edited
    }
    if (Object.keys(values).length === 0) {
      setEditForm(undefined)
      return
    }
    try {
      await registryUpdateRow(cn.http, { directory: d, table, rowid: row.rowid, values })
    } catch (error) {
      showToast({ variant: "error", title: "Registry write failed", description: String(error) })
      return
    }
    setEditForm(undefined)
    setTick((t) => t + 1)
  }

  async function deleteRow(form: EditRowForm) {
    const cn = conn()
    const d = routeDir()
    const table = form.table
    const row = form.row
    if (!cn || !d) return
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
    setEditForm(undefined)
    setTick((t) => t + 1)
  }

  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <AppPageHeader
        dense
        glyph="registry"
        title="Registry"
        hint="the instance database, editable — changes are immediate and unguarded"
      />
      <div class="flex min-h-0 flex-1">
        {/* 🔴 The rail used to be a bare `<For each={tables() ?? []}>` with no fallback of any kind,
            so a failed read rendered an empty 224px column: not an empty state, not an error,
            nothing — while the pane beside it invited the user to pick from the list that had just
            failed to arrive. Four states, four sentences (ruling 2). */}
        <div class="w-56 shrink-0 overflow-y-auto border-r border-v2-border-border-base p-2">
          {/* `idle` and `loading` share the fallback's sentence. They are still separate facts, but
              a rail that has not asked yet and a rail that is asking both have nothing to list —
              what neither may do is render the empty state, or nothing at all. */}
          <Switch
            fallback={
              <div data-slot="registry-tables-loading" class="p-2 text-[12px] text-v2-text-text-faint">
                {REGISTRY_COPY.tablesLoading}
              </div>
            }
          >
            <Match when={tableList().kind === "failed"}>
              <div data-slot="registry-tables-failed" class="p-2 text-[12px] text-v2-state-fg-danger">
                {REGISTRY_COPY.tablesFailed}
                <button
                  type="button"
                  class={`${btn} mt-2 block`}
                  onClick={() => {
                    void routeDirActions.refetch()
                    void tablesActions.refetch()
                  }}
                >
                  Try again
                </button>
              </div>
            </Match>
            <Match when={tableList().kind === "empty"}>
              <div data-slot="registry-tables-empty" class="p-2 text-[12px] text-v2-text-text-faint">
                {REGISTRY_COPY.tablesEmpty}
              </div>
            </Match>
            <Match when={tableRows()}>
              {(rows) => (
                <For each={[...rows()]}>
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
              )}
            </Match>
          </Switch>
        </div>
        <div class="min-w-0 flex-1 overflow-auto">
          <Switch
            fallback={
              <div class="p-6 text-[13px] text-v2-text-text-faint">
                {selected() ? "Loading…" : "Pick a table — hives on the left, rows here."}
              </div>
            }
          >
            <Match when={rowsFailed()}>
              <div data-slot="registry-rows-failed" class="p-6 text-[13px] text-v2-state-fg-danger">
                {REGISTRY_COPY.rowsFailed}
                <button type="button" class={`${btn} mt-2 block`} onClick={() => void pageActions.refetch()}>
                  Try again
                </button>
              </div>
            </Match>
            {/* Nothing is selected AND the rail has no list to pick from: "pick a table" would be an
                instruction the screen cannot honour. */}
            <Match when={!selected() && tableList().kind === "failed"}>
              <div class="p-6 text-[13px] text-v2-text-text-faint">
                There is no table list to pick from — see the panel on the left.
              </div>
            </Match>
            <Match when={page()}>
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
                            classList={{ "bg-v2-background-bg-layer-02": editRowForm()?.row.rowid === row.rowid }}
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
                    <button
                      type="button"
                      class={btn}
                      disabled={offset() === 0}
                      onClick={() => setOffset(Math.max(0, offset() - PAGE_SIZE))}
                    >
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
                  <Show when={newRowForm()}>
                    {(form) => (
                      <div data-component="registry-new-row" class="border-t border-v2-border-border-base p-3">
                        <div class="mb-2 flex items-center gap-2">
                          <span class="text-[12px] font-semibold text-v2-text-text-base">
                            New row in {form().table}
                          </span>
                          <Show when={CONFIG_BACKED_TABLES.has(form().table)}>
                            <span class="text-[11px] text-v2-state-fg-warning">
                              live config — an unknown key stops the instance booting
                            </span>
                          </Show>
                          <div class="flex-1" />
                          <button type="button" class={btn} onClick={() => void insertRow(form())}>
                            Insert
                          </button>
                          <button type="button" class={btn} onClick={() => setNewForm(undefined)}>
                            Cancel
                          </button>
                        </div>
                        <div class="grid gap-2" style={{ "grid-template-columns": "minmax(120px, 200px) 1fr" }}>
                          <For each={[...form().columns]}>
                            {(column) => (
                              <>
                                <div class="pt-1 font-mono text-[12px] text-v2-text-text-faint">{column}</div>
                                <textarea
                                  rows={1}
                                  aria-label={column}
                                  data-registry-new-column={column}
                                  class="min-h-7 w-full resize-y rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 font-mono text-[12px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
                                  value={form().draft[column] ?? ""}
                                  onInput={(event) => form().setDraft(column, event.currentTarget.value)}
                                />
                              </>
                            )}
                          </For>
                        </div>
                        <div class="pt-2 text-[11px] text-v2-text-text-faint">
                          Blank fields are left unset, so the column default (or NULL) applies.
                        </div>
                      </div>
                    )}
                  </Show>
                  <Show when={editRowForm()}>
                    {(form) => (
                      <div data-component="registry-editor" class="border-t border-v2-border-border-base p-3">
                        <div class="mb-2 flex items-center gap-2">
                          <span class="text-[12px] font-semibold text-v2-text-text-base">
                            Edit rowid {form().row.rowid}
                          </span>
                          <div class="flex-1" />
                          <button type="button" class={btn} onClick={() => void saveRow(form())}>
                            Save changes
                          </button>
                          <button type="button" class={btn} onClick={() => void deleteRow(form())}>
                            Delete row
                          </button>
                          <button type="button" class={btn} onClick={() => setEditForm(undefined)}>
                            Close
                          </button>
                        </div>
                        <div class="grid gap-2" style={{ "grid-template-columns": "minmax(120px, 200px) 1fr" }}>
                          <For each={[...form().columns]}>
                            {(column) => (
                              <>
                                <div class="pt-1 font-mono text-[12px] text-v2-text-text-faint">{column}</div>
                                <textarea
                                  rows={1}
                                  aria-label={column}
                                  data-registry-column={column}
                                  class="min-h-7 w-full resize-y rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1 font-mono text-[12px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
                                  value={form().draft[column] ?? ""}
                                  onInput={(event) => form().setDraft(column, event.currentTarget.value)}
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
            </Match>
          </Switch>
        </div>
      </div>
    </AppPage>
  )
}
