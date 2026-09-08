import { For, Show, createMemo, type Component } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
// ⚠️ VALUE import, and it is safe because `log-bounds.ts` has no imports at all — the writer it
// belongs to (`observability/log-file.ts`) pulls in `node:fs`/`node:zlib` at module scope and would
// break this bundle. The alternative was retyping "30 days" and "256 MB" into a user-facing
// sentence, which is the one-description-twice defect with the copy in the worst possible place:
// when the writer's bound moves, the product starts telling people something false and no test is
// about it. See that module's header.
import { LogBounds } from "@novaclaw/core/observability/log-bounds"
import { LogSettings } from "@novaclaw/core/observability/log-settings"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { InstanceResources } from "./instance-resources"
import { STORAGE_ENTRIES, type PathInfo } from "./storage-entries"
import { SettingsExplainV2 } from "./explain"
import { useSettingsConfigWrite } from "./parts/config-write"

// The Storage tab — what this instance costs in RAM/on disk, and WHERE it keeps things.
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

type LogLevel = "debug" | "info" | "warn" | "error"
interface LogConfig {
  level?: LogLevel
  retention_days?: number
  subsystems?: Record<string, LogLevel | undefined>
}

interface TrashConfig {
  retention_days?: number
}

export const SettingsStorageV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const sync = useServerSync()
  const expertise = useExpertise()
  const writeConfig = useSettingsConfigWrite()

  // The SDK's generated PathInfo type lags the fields the server sends (same cast the new-agent bar
  // uses for scratchDir); regenerating the client for a read-only display is not worth the churn.
  const paths = (): PathInfo => (sync().data.path ?? {}) as PathInfo
  const logConfig = createMemo(() => ((sync().data.config as { log?: LogConfig } | undefined)?.log ?? {}) as LogConfig)
  const trashConfig = createMemo(() => ((sync().data.config as { trash?: TrashConfig } | undefined)?.trash ?? {}) as TrashConfig)
  const levelOptions = createMemo(() =>
    (["debug", "info", "warn", "error"] as const).map((value) => ({
      id: value,
      value,
      label: language.t(`settings.storage.logs.level.${value}`),
    })),
  )
  const retentionOptions = createMemo(() =>
    [7, 30, 90, 180, 365].map((value) => ({
      id: String(value),
      value,
      label: language.t("settings.storage.logs.retention.days", { days: value }),
    })),
  )
  const trashRetentionOptions = createMemo(() =>
    [7, 30, 90, 180, 365].map((value) => ({
      id: String(value),
      value,
      label: language.t("settings.storage.trash.retention.days", { days: value }),
    })),
  )
  const saveLog = async (next: LogConfig) => {
    try {
      await sync().updateConfig({ log: next } as never)
    } catch (error) {
      showToast({
        title: language.t("settings.storage.logs.saveFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

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
    void platform
      .openPath?.(value)
      ?.catch?.(() => showToast({ title: language.t("settings.storage.openFailed"), description: value }))
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.storage.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.storage.description")}</p>
      </div>

      <InstanceResources />

      <div>
        <h3 class="settings-v2-section-title">{language.t("settings.storage.trash.title")}</h3>
        <p class="settings-v2-tab-description">{language.t("settings.storage.trash.description")}</p>
      </div>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.storage.trash.retention")}
          description={language.t("settings.storage.trash.retention.description", {
            days: trashConfig().retention_days ?? 30,
          })}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-trash-retention"
            options={trashRetentionOptions()}
            current={
              trashRetentionOptions().find((option) => option.value === (trashConfig().retention_days ?? 30)) ??
              trashRetentionOptions()[1]
            }
            value={(option) => option.id}
            label={(option) => option.label}
            onSelect={(option) => {
              if (!option || option.value === (trashConfig().retention_days ?? 30)) return
              void writeConfig({ trash: { ...trashConfig(), retention_days: option.value } })
            }}
          />
        </SettingsRowV2>
      </SettingsListV2>

      <div>
        <h3 class="settings-v2-section-title">{language.t("settings.storage.locations.title")}</h3>
        <p class="settings-v2-tab-description">{language.t("settings.storage.locations.description")}</p>
      </div>

      {/* Only shown when the instance was pinned with --home: it changes what every row below means
          (one self-contained folder instead of the shared per-user locations), so it leads. */}
      <Show when={paths().instanceHome}>
        {(home) => (
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.storage.instanceHome")}
              description={
                <>
                  {language.t("settings.storage.instanceHome.description")}
                  <SettingsExplainV2 label={language.t("settings.storage.instanceHome")}>
                    {language.t("settings.storage.instanceHome.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <PathValue
                value={home()}
                onCopy={copy}
                onOpen={canOpen() ? open : undefined}
                copyLabel={language.t("settings.storage.copy")}
                openLabel={language.t("settings.storage.open")}
              />
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
                  title={language.t(`settings.storage.${entry.i18n}`)}
                  description={language.t(`settings.storage.${entry.i18n}.description`)}
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

      {/* ── Activity log ─────────────────────────────────────────────────────────────────────────
          Log retention belongs BESIDE storage rather than in a new tab, and this is that row.

          ⚠️ **Which knob this is, and which it deliberately is not.** This is the LOCAL log: it never
          leaves the machine, and the self-healing loop reads it — *"an agent asked to repair an
          instance needs to READ what went wrong."* There is therefore **no off switch here and there
          must never be one**; a lay user who silenced this would be disabling the thing that makes
          their own instance diagnosable, and they would do it believing they had turned off
          telemetry. The switch they are actually looking for is crash reporting, which is a
          different plane (AGENTS.md principle 4), is Developer-gated on purpose, and the description
          below names so nobody hunts for it here.

          The controls write the active instance through PATCH /config. Core projects that SQLite row
          into a synchronous hot-path policy, so the already-open writer changes immediately. */}
      <div>
        <h3 class="settings-v2-section-title">{language.t("settings.storage.logs.title")}</h3>
        <p class="settings-v2-tab-description">{language.t("settings.storage.logs.description")}</p>
      </div>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.storage.logs.retention")}
          description={language.t("settings.storage.logs.retention.description", {
            days: logConfig().retention_days ?? RETENTION.days,
            size: RETENTION.size,
          })}
          minLevel="advanced"
        >
          <SelectV2
            appearance="inline"
            data-action="settings-log-retention"
            options={retentionOptions()}
            current={
              retentionOptions().find((option) => option.value === (logConfig().retention_days ?? RETENTION.days)) ??
              retentionOptions()[1]
            }
            value={(option) => option.id}
            label={(option) => option.label}
            onSelect={(option) => {
              if (!option || option.value === (logConfig().retention_days ?? RETENTION.days)) return
              void saveLog({ ...logConfig(), retention_days: option.value })
            }}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.storage.logs.level")}
          description={
            <>
              {language.t("settings.storage.logs.level.description")}
              <SettingsExplainV2 label={language.t("settings.storage.logs.level")}>
                {language.t("settings.storage.logs.level.description.more")}
              </SettingsExplainV2>
            </>
          }
          minLevel="advanced"
        >
          <LogLevelSelect
            options={levelOptions()}
            current={logConfig().level ?? "info"}
            action="settings-log-level"
            onChange={(level) => saveLog({ ...logConfig(), level })}
          />
        </SettingsRowV2>
      </SettingsListV2>

      <Show when={expertise.atLeast("developer")}>
        <div>
          <h3 class="settings-v2-section-title">{language.t("settings.storage.logs.subsystems.title")}</h3>
          <p class="settings-v2-tab-description">{language.t("settings.storage.logs.subsystems.description")}</p>
        </div>
        <SettingsListV2>
          <For each={Object.entries(LogSettings.subsystems)}>
            {([subsystem, label]) => (
              <SettingsRowV2 title={label} description={subsystem}>
                <LogLevelSelect
                  options={levelOptions()}
                  current={logConfig().subsystems?.[subsystem] ?? logConfig().level ?? "info"}
                  action={`settings-log-subsystem-${subsystem}`}
                  onChange={(level) =>
                    saveLog({
                      ...logConfig(),
                      subsystems: { ...logConfig().subsystems, [subsystem]: level },
                    })
                  }
                />
              </SettingsRowV2>
            )}
          </For>
        </SettingsListV2>
      </Show>
    </>
  )
}

/**
 * The retention sentence's two numbers, read from the writer's own constants rather than typed here.
 *
 * `days` is deliberately approximate: age rotation seals a quiet active segment at that age and
 * age deletion happens one window later, while the independent byte ceiling may delete old segments
 * sooner under heavy traffic. The byte figure alone is a hard ceiling.
 */
const RETENTION = {
  days: LogBounds.MAX_AGE_DAYS,
  size: `${Math.round(LogBounds.TOTAL_BYTES / (1024 * 1024))} MB`,
}

interface LevelOption {
  id: LogLevel
  value: LogLevel
  label: string
}

const LogLevelSelect: Component<{
  options: LevelOption[]
  current: LogLevel
  action: string
  onChange: (level: LogLevel) => void | Promise<void>
}> = (props) => (
  <SelectV2
    appearance="inline"
    data-action={props.action}
    options={props.options}
    current={props.options.find((option) => option.value === props.current) ?? props.options[1]}
    value={(option) => option.id}
    label={(option) => option.label}
    onSelect={(option) => {
      if (!option || option.value === props.current) return
      void props.onChange(option.value)
    }}
  />
)

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
      class="min-w-0 flex-1 select-all truncate rounded bg-v2-background-bg-deep px-1.5 py-1 text-[12px] text-v2-text-text-muted"
      title={props.value}
      data-slot="settings-v2-storage-path"
    >
      {props.value}
    </code>
    <ButtonV2
      variant="ghost"
      size="small"
      onClick={() => props.onCopy(props.value)}
      aria-label={props.copyLabel}
      title={props.copyLabel}
    >
      <Icon name="copy" size="normal" />
    </ButtonV2>
    <Show when={props.onOpen}>
      {(onOpen) => (
        <ButtonV2
          variant="ghost"
          size="small"
          onClick={() => onOpen()(props.value)}
          aria-label={props.openLabel}
          title={props.openLabel}
        >
          <Icon name="folder" size="normal" />
        </ButtonV2>
      )}
    </Show>
  </div>
)
