import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { GoldGlyph } from "@/components/gold-glyph"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useLanguage, type Translator } from "@/context/language"
import { showToast } from "@/utils/toast"
import { fsTrashList, fsTrashRestore, type TrashEntry } from "@/utils/fs-api"
import { AppPage, AppPageHeader } from "@/components/app-page"
import { resolveInstanceGlobalDirectory } from "@/utils/routing-directory"
import { answeredNothing, createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"
import * as Timestamp from "@novaclaw/schema/time"

// The Trash app (B8 surface — plan.md M6). A home tile over the M4 endpoints: list every trashed
// entry (the store is GLOBAL — deletions from any root land here), restore with one click, and show
// the live server retention countdown.

function expiresLabel(trashedAt: unknown, retentionDays: number, t: Translator): string {
  const at = Timestamp.toEpochMillis(trashedAt)
  if (at === undefined) return ""
  const left = at + retentionDays * 24 * 3600 * 1000 - Date.now()
  if (left <= 0) return t("trash.expiringNow")
  const hours = Math.round(left / 3600_000)
  if (hours < 1) return t("trash.expiresUnderHour")
  return `${t("trash.expiresIn")} ~${hours}h`
}

export function TrashPage() {
  const global = useGlobal()
  const server = useServer()
  const sync = useServerSync()
  const language = useLanguage()
  const retentionDays = createMemo(() => {
    const trash = (sync().data.config as { trash?: { retention_days?: number } } | undefined)?.trash
    return trash?.retention_days ?? 30
  })

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const [tick, setTick] = createSignal(0)

  // The trash store is global; `directory` is only for request routing — the server's home works.
  // The read itself is `utils/routing-directory.ts`, shared verbatim with registry.tsx and
  // terminal.tsx.
  const [routeDir] = createSettledResource(ctx, resolveInstanceGlobalDirectory)

  const [entries] = createSettledResource(
    () => {
      const cn = conn()
      const d = routeDir()
      return cn && d ? { cn, d, t: tick() } : undefined
    },
    // No `.catch` here on purpose: a rejection is `createSettledResource`'s business, and a fetcher
    // that swallows its own failure hands the caller back the `undefined` an unasked read produces —
    // which is precisely the confusion this page shipped.
    ({ cn, d }) => fsTrashList(cn.http, { directory: d }),
  )

  /**
   * 🔴 **The defect this page was the poster child for.** The listing already had three outcomes and
   * the render printed `"Trash is empty."` for two of them, so a Trash that could not be READ looked
   * exactly like a Trash with nothing in it — on the one screen whose entire job is to tell someone
   * their deleted file is still recoverable.
   *
   * ⚠️ `failedWhen` covers the OTHER way this panel could lie. `resolveInstanceGlobalDirectory`
   * folds a failed `GET /path` into `""`, and `""` gates the listing off, so a broken path lookup
   * used to leave the panel permanently at "not asked" — a spinner that resolves to nothing, which
   * is the same false claim wearing a different animation.
   */
  const listing = createListState<TrashEntry>(entries, { failedWhen: () => answeredNothing(routeDir) })
  const loaded = createMemo(() => {
    const state = listing()
    return state.kind === "loaded" ? state.items : undefined
  })

  async function doRestore(entry: TrashEntry) {
    const cn = conn()
    const d = routeDir()
    if (!cn || !d) return
    try {
      await fsTrashRestore(cn.http, { directory: d, id: entry.id })
    } catch (error) {
      // Surface restore failures instead of a silent no-op (SP5).
      showToast({ variant: "error", title: language.t("trash.restoreFailed"), description: String(error) })
      return
    }
    setTick((t) => t + 1)
  }

  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <AppPage class="flex flex-col overflow-hidden">
      <AppPageHeader
        glyph="trash"
        title={language.t("trash.title")}
        hint={language.t("trash.hint", { days: retentionDays() })}
      >
        <button type="button" class={btn} onClick={() => setTick((t) => t + 1)} disabled={!routeDir()}>
          {language.t("trash.refresh")}
        </button>
      </AppPageHeader>

      <div class="min-h-0 flex-1 overflow-auto py-1">
        <Switch fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("trash.loading")}</div>}>
          <Match when={listing().kind === "failed"}>
            <div
              class="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-v2-state-fg-danger"
              data-slot="trash-failed"
            >
              {language.t("trash.loadFailed")}
            </div>
          </Match>
          <Match when={listing().kind === "empty"}>
            <div
              class="flex flex-col items-center gap-3 px-4 py-12 text-sm text-v2-text-text-faint"
              data-slot="trash-empty"
            >
              <GoldGlyph name="trash" class="size-12 opacity-60" />
              {language.t("trash.empty")}
            </div>
          </Match>
          <Match when={loaded()}>
            {(rows) => (
              <For each={rows()}>
                {(entry) => (
                  <div class="flex items-center gap-2 px-4 py-1.5 text-sm hover:bg-v2-background-bg-layer-02">
                    <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                      <Icon name="folder" size="normal" class="shrink-0 text-v2-text-text-muted" />
                    </Show>
                    <span class="min-w-0 flex-1 truncate" title={entry.originalPath}>
                      {entry.originalPath}
                    </span>
                    <span class="shrink-0 text-xs text-v2-text-text-faint">
                      {Timestamp.toDate(entry.trashedAt)?.toLocaleString() ?? "—"}
                    </span>
                    <span class="shrink-0 text-xs text-v2-text-text-faint">
                      {expiresLabel(entry.trashedAt, retentionDays(), language.t)}
                    </span>
                    <button type="button" class={btn} onClick={() => void doRestore(entry)}>
                      {language.t("trash.restore")}
                    </button>
                  </div>
                )}
              </For>
            )}
          </Match>
        </Switch>
      </div>
    </AppPage>
  )
}
