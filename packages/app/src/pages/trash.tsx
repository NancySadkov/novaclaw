import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { fsTrashList, fsTrashRestore, type TrashEntry } from "@/utils/fs-api"

// The Trash app (B8 surface — plan.md M6). A home tile over the M4 endpoints: list every trashed
// entry (the store is GLOBAL — deletions from any root land here), restore with one click, and show
// the TTL countdown (~2 days from trashedAt, then the lazy purge removes it for real).
const TTL_MS = 2 * 24 * 3600 * 1000

function expiresLabel(trashedAt: number, t: (key: string) => string): string {
  const left = trashedAt + TTL_MS - Date.now()
  if (left <= 0) return t("trash.expiringNow")
  const hours = Math.round(left / 3600_000)
  if (hours < 1) return t("trash.expiresUnderHour")
  return `${t("trash.expiresIn")} ~${hours}h`
}

export function TrashPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const [tick, setTick] = createSignal(0)

  // The trash store is global; `directory` is only for request routing — the server's home works.
  const [routeDir] = createResource(ctx, async (c) => {
    const p = c.sync.data.path
    if (p && (p.home || p.directory)) return p.home || p.directory
    const got = await c.sdk.client.path
      .get()
      .then((r) => r.data)
      .catch(() => undefined)
    return got?.home || got?.directory || ""
  })

  const [entries] = createResource(
    () => {
      const cn = conn()
      const d = routeDir()
      return cn && d ? { cn, d, t: tick() } : undefined
    },
    ({ cn, d }) => fsTrashList(cn.http, { directory: d }).catch(() => undefined),
  )

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
    <div class="flex min-h-0 flex-1 flex-col self-stretch m-2 rounded-[10px] overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] text-v2-text-text-base">
      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5">
        <Icon name="trash" size="normal" class="shrink-0 text-v2-text-text-muted" />
        <span class="text-[15px] font-semibold">{language.t("trash.title")}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-v2-text-text-faint">{language.t("trash.hint")}</span>
        <button type="button" class={btn} onClick={() => setTick((t) => t + 1)} disabled={!routeDir()}>
          {language.t("trash.refresh")}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto py-1">
        <Show
          when={entries()}
          fallback={
            <div class="px-4 py-3 text-sm text-v2-text-text-faint">
              {entries.loading ? language.t("trash.loading") : language.t("trash.empty")}
            </div>
          }
        >
          <Show
            when={entries()!.length}
            fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("trash.empty")}</div>}
          >
            <For each={entries()}>
              {(entry) => (
                <div class="flex items-center gap-2 px-4 py-1.5 text-sm hover:bg-v2-background-bg-layer-02">
                  <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                    <Icon name="folder" size="small" class="shrink-0 text-v2-text-text-muted" />
                  </Show>
                  <span class="min-w-0 flex-1 truncate" title={entry.originalPath}>
                    {entry.originalPath}
                  </span>
                  <span class="shrink-0 text-xs text-v2-text-text-faint">
                    {new Date(entry.trashedAt).toLocaleString()}
                  </span>
                  <span class="shrink-0 text-xs text-v2-text-text-faint">
                    {expiresLabel(entry.trashedAt, language.t)}
                  </span>
                  <button type="button" class={btn} onClick={() => void doRestore(entry)}>
                    {language.t("trash.restore")}
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
