import { For, Match, Show, Switch, createMemo, createSignal, type Component } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useLanguage, type Translator } from "@/context/language"
import { showToast } from "@/utils/toast"
import { fsTrashList, fsTrashRestore, type TrashEntry } from "@/utils/fs-api"
import { resolveInstanceGlobalDirectory } from "@/utils/routing-directory"
import { answeredNothing, createSettledResource } from "@/utils/settled-resource"
import { createListState } from "@/utils/list-state"
import * as Timestamp from "@novaclaw/schema/time"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { useSettingsConfigWrite } from "./parts/config-write"

// The Trash panel — the former Trash home app, merged into Settings → Safety (owner, 2026-09-16).
//
// The store is GLOBAL: deletions from any root land here. This panel both CONFIGURES retention and
// lets the user RESTORE an entry, because those two are the same subject — a page that only linked to
// another screen for the destructive half is how the old split read.
//
// ⚠️ The three-outcome rule the old page learned the hard way is carried over verbatim: a listing
// that could not be READ must never render as "Trash is empty." `createListState` plus
// `failedWhen` keep "failed" distinct from "empty"; see `pages/trash.tsx`'s history in git.

function expiresLabel(trashedAt: unknown, retentionDays: number, t: Translator): string {
  const at = Timestamp.toEpochMillis(trashedAt)
  if (at === undefined) return ""
  const left = at + retentionDays * 24 * 3600 * 1000 - Date.now()
  if (left <= 0) return t("trash.expiringNow")
  const hours = Math.round(left / 3600_000)
  if (hours < 1) return t("trash.expiresUnderHour")
  return `${t("trash.expiresIn")} ~${hours}h`
}

interface TrashConfig {
  retention_days?: number
}

export const SettingsTrashV2: Component = () => {
  const global = useGlobal()
  const server = useServer()
  const sync = useServerSync()
  const language = useLanguage()
  const writeConfig = useSettingsConfigWrite()

  const trashConfig = createMemo(
    () => ((sync().data.config as { trash?: TrashConfig } | undefined)?.trash ?? {}) as TrashConfig,
  )
  const retentionDays = createMemo(() => trashConfig().retention_days ?? 30)
  const retentionOptions = createMemo(() =>
    [7, 30, 90, 180, 365].map((value) => ({
      id: String(value),
      value,
      label: language.t("settings.storage.trash.retention.days", { days: value }),
    })),
  )

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const [tick, setTick] = createSignal(0)

  // The trash store is global; `directory` is only for request routing — the server's home works.
  const [routeDir] = createSettledResource(ctx, resolveInstanceGlobalDirectory)
  const [entries] = createSettledResource(
    () => {
      const cn = conn()
      const d = routeDir()
      return cn && d ? { cn, d, t: tick() } : undefined
    },
    ({ cn, d }) => fsTrashList(cn.http, { directory: d }),
  )

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
      showToast({ variant: "error", title: language.t("trash.restoreFailed"), description: String(error) })
      return
    }
    setTick((t) => t + 1)
  }

  const btn =
    "rounded-md px-2.5 py-1 text-xs font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 disabled:pointer-events-none disabled:opacity-40"

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("trash.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("trash.hint", { days: retentionDays() })}</p>
      </div>

      <div class="settings-v2-tab-body">
        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.storage.trash.retention")}
            description={language.t("settings.storage.trash.retention.description", { days: retentionDays() })}
          >
            <SelectV2
              appearance="inline"
              data-action="settings-trash-retention"
              options={retentionOptions()}
              current={
                retentionOptions().find((option) => option.value === retentionDays()) ?? retentionOptions()[1]
              }
              value={(option) => option.id}
              label={(option) => option.label}
              onSelect={(option) => {
                if (!option || option.value === retentionDays()) return
                void writeConfig({ trash: { ...trashConfig(), retention_days: option.value } })
              }}
            />
          </SettingsRowV2>
        </SettingsListV2>

        <div class="flex items-center justify-between gap-3">
          <h3 class="settings-v2-section-title">{language.t("settings.trash.contents")}</h3>
          <button type="button" class={btn} onClick={() => setTick((t) => t + 1)} disabled={!routeDir()}>
            {language.t("trash.refresh")}
          </button>
        </div>

        <div class="min-h-0">
          <Switch fallback={<div class="px-4 py-3 text-sm text-v2-text-text-faint">{language.t("trash.loading")}</div>}>
            <Match when={listing().kind === "failed"}>
              <div
                class="flex flex-col items-center gap-3 rounded-lg border border-v2-border-border-base px-4 py-12 text-center text-sm text-v2-state-fg-danger"
                data-slot="trash-failed"
              >
                {language.t("trash.loadFailed")}
              </div>
            </Match>
            <Match when={listing().kind === "empty"}>
              <div
                class="flex flex-col items-center gap-3 rounded-lg border border-v2-border-border-base px-4 py-12 text-sm text-v2-text-text-faint"
                data-slot="trash-empty"
              >
                <Icon name="trash" class="size-10 opacity-40" />
                {language.t("trash.empty")}
              </div>
            </Match>
            <Match when={loaded()}>
              {(rows) => (
                <SettingsListV2>
                  <For each={rows()}>
                    {(entry) => (
                      <SettingsRowV2
                        title={
                          <span class="flex min-w-0 items-center gap-2">
                            <Show when={entry.type === "directory"} fallback={<span class="size-4 shrink-0" />}>
                              <Icon name="folder" size="normal" class="shrink-0 text-v2-text-text-muted" />
                            </Show>
                            <span class="min-w-0 truncate" title={entry.originalPath}>
                              {entry.originalPath}
                            </span>
                          </span>
                        }
                        description={`${Timestamp.toDate(entry.trashedAt)?.toLocaleString() ?? "—"} · ${expiresLabel(
                          entry.trashedAt,
                          retentionDays(),
                          language.t,
                        )}`}
                      >
                        <button type="button" class={btn} onClick={() => void doRestore(entry)}>
                          {language.t("trash.restore")}
                        </button>
                      </SettingsRowV2>
                    )}
                  </For>
                </SettingsListV2>
              )}
            </Match>
          </Switch>
        </div>
      </div>
    </>
  )
}
