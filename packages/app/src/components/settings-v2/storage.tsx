import { For, Show, type Component } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// The Storage tab — WHERE this instance keeps things. Advanced+ (owner ask 2026-07-27).
//
// Why it exists: none of these locations was discoverable from the UI. "Where is the database?" had no
// answer you could reach without reading source, which matters the moment someone wants to back up an
// instance, inspect it, copy it to another machine, or delete it cleanly. It also makes a whole class of
// confusion self-diagnosable — the v0.1.0 first-run bug resolved the data directory to a folder literally
// named "undefined", and this tab would have shown that at a glance instead of surfacing as an
// unexplained 500.
//
// Read-only on purpose. These paths are chosen by `--home`/NOVACLAW_HOME and the XDG environment at
// startup, so an editable field here would be a lie — it could not move the files an already-running
// instance has open. The tab tells you where things are and hands you the path; relocating is a launch
// decision, which the instance-home row explains.

interface PathInfo {
  home?: string
  state?: string
  config?: string
  data?: string
  cache?: string
  tmp?: string
  log?: string
  db?: string
  scratchDir?: string
  instanceHome?: string
}

/**
 * One displayed location. `level` omitted means Advanced (the tab's own floor); `"developer"` hides the
 * row below Developer.
 *
 * Exported as pure data so the Advanced-vs-Developer split is unit-testable — the split is the part
 * that is easy to get silently wrong, and asserting it here is more durable than driving the dialog.
 * `i18n` is the suffix under `settings.storage.*`, kept explicit because it does not always match `key`
 * (`scratchDir` → `scratch`).
 */
export interface StorageEntry {
  key: keyof PathInfo
  i18n: string
  level?: "developer"
}

export const STORAGE_ENTRIES: StorageEntry[] = [
  { key: "config", i18n: "config" },
  { key: "data", i18n: "data" },
  { key: "db", i18n: "db" },
  { key: "scratchDir", i18n: "scratch" },
  { key: "log", i18n: "log" },
  // Internal plumbing: real, but nothing a power user needs to see to back up or move an instance.
  { key: "state", i18n: "state", level: "developer" },
  { key: "cache", i18n: "cache", level: "developer" },
  { key: "tmp", i18n: "tmp", level: "developer" },
]

export const SettingsStorageV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const sync = useServerSync()

  // The SDK's generated PathInfo type lags the fields the server sends (same cast the new-agent bar
  // uses for scratchDir); regenerating the client for a read-only display is not worth the churn.
  const paths = (): PathInfo => (sync().data.path ?? {}) as PathInfo

  const copy = (value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => showToast({ title: language.t("settings.storage.copied") }))
      .catch(() => showToast({ title: language.t("settings.storage.copyFailed"), description: value }))
  }

  // Desktop only: `openPath` is absent on web, so the button is not rendered there rather than being
  // shown and doing nothing.
  const canOpen = () => typeof platform.openPath === "function"
  const open = (value: string) => {
    void platform.openPath?.(value)?.catch?.(() =>
      showToast({ title: language.t("settings.storage.openFailed"), description: value }),
    )
  }

  // Dynamic i18n keys need the loose-key cast the translator otherwise forbids (same as general.tsx).
  const tk = (key: string) => language.t(key as Parameters<typeof language.t>[0])

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.storage.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.storage.description")}</p>
      </div>

      {/* Only shown when the instance was pinned with --home: it changes what every row below means
          (one self-contained folder instead of the shared per-user locations), so it leads. */}
      <Show when={paths().instanceHome}>
        {(home) => (
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.storage.instanceHome")}
              description={language.t("settings.storage.instanceHome.description")}
            >
              <PathValue value={home()} onCopy={copy} onOpen={canOpen() ? open : undefined} copyLabel={language.t("settings.storage.copy")} openLabel={language.t("settings.storage.open")} />
            </SettingsRowV2>
          </SettingsListV2>
        )}
      </Show>

      <SettingsListV2>
        <For each={STORAGE_ENTRIES}>
          {(entry) => (
            <Show when={paths()[entry.key]}>
              {(value) => (
                <SettingsRowV2
                  title={tk(`settings.storage.${entry.i18n}`)}
                  description={tk(`settings.storage.${entry.i18n}.description`)}
                  minLevel={entry.level}
                >
                  <PathValue
                    value={value()}
                    onCopy={copy}
                    onOpen={canOpen() ? open : undefined}
                    copyLabel={language.t("settings.storage.copy")}
                    openLabel={language.t("settings.storage.open")}
                  />
                </SettingsRowV2>
              )}
            </Show>
          )}
        </For>
      </SettingsListV2>
    </>
  )
}

/** The path itself, selectable, plus Copy and (on desktop) Open. */
const PathValue: Component<{
  value: string
  copyLabel: string
  openLabel: string
  onCopy: (value: string) => void
  onOpen?: (value: string) => void
}> = (props) => (
  <div class="flex min-w-0 items-center gap-1.5">
    {/* `select-all` + title: the path is often longer than the row, so a click selects the whole thing
        and the tooltip shows it in full even when it is visually truncated. */}
    <code
      class="min-w-0 flex-1 select-all truncate rounded bg-v2-surface-surface-sunken px-1.5 py-1 text-[12px] text-v2-text-text-muted"
      title={props.value}
      data-slot="settings-v2-storage-path"
    >
      {props.value}
    </code>
    <ButtonV2 variant="ghost" size="small" onClick={() => props.onCopy(props.value)} aria-label={props.copyLabel} title={props.copyLabel}>
      <Icon name="copy" size="small" />
    </ButtonV2>
    <Show when={props.onOpen}>
      {(onOpen) => (
        <ButtonV2 variant="ghost" size="small" onClick={() => onOpen()(props.value)} aria-label={props.openLabel} title={props.openLabel}>
          <Icon name="folder" size="small" />
        </ButtonV2>
      )}
    </Show>
  </div>
)
