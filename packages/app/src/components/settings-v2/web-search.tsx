import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { type Component, Show } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// The Web Search settings tab (todo.md → "a built-in fallback so it just works for lay users").
// Advanced/Developer level: a normal person never needs to touch this — search just works via the
// built-in in-process meta-search. This tab is the power-user override (point at your own SearXNG)
// plus the self-healing knob (disable a built-in engine that starts misbehaving) — an agent can
// already repair it through config, and this is the human's door to the same store. Persist via
// updateConfig (the golden config-write rule); the WebSearch service reads the same `web_search`
// key at call time, so a change takes effect with no restart.

interface ThrottleConfig {
  hostIntervalMs?: number
  burst?: number
  perHostConcurrency?: number
  dailyPerHost?: number
  sameUrlLimit?: number
}

interface WebSearchConfig {
  searxngUrl?: string
  disabledEngines?: string[]
  timeoutMs?: number
  throttle?: ThrottleConfig
}

// The traffic-governor knobs (core/web/fetch-pace.ts). Defaults shown as placeholders, so an empty
// field reads as "use the default" rather than "zero". Kept in step with that module's constants.
const THROTTLE_FIELDS: Array<{
  key: keyof ThrottleConfig
  label: string
  hint: string
  fallback: number
  min: number
}> = [
  { key: "hostIntervalMs", label: "settings.webSearch.throttle.interval", hint: "settings.webSearch.throttle.interval.hint", fallback: 4000, min: 0 },
  { key: "burst", label: "settings.webSearch.throttle.burst", hint: "settings.webSearch.throttle.burst.hint", fallback: 3, min: 1 },
  { key: "perHostConcurrency", label: "settings.webSearch.throttle.concurrency", hint: "settings.webSearch.throttle.concurrency.hint", fallback: 1, min: 1 },
  { key: "dailyPerHost", label: "settings.webSearch.throttle.daily", hint: "settings.webSearch.throttle.daily.hint", fallback: 150, min: 1 },
  { key: "sameUrlLimit", label: "settings.webSearch.throttle.sameUrl", hint: "settings.webSearch.throttle.sameUrl.hint", fallback: 3, min: 1 },
]

// The built-in engines, so a user can toggle one off by name. Kept in step with
// core/websearch/service.ts resolveEngines — a short, stable list.
const BUILTIN_ENGINES: Array<{ id: string; label: string }> = [
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "wikipedia", label: "Wikipedia" },
]

export const SettingsWebSearchV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const current = (): WebSearchConfig => ((serverSync().data.config as { web_search?: WebSearchConfig }).web_search ?? {})
  const usingSearxng = () => (current().searxngUrl ?? "").trim().length > 0
  // Airgap force-disables search (the WebSearch service refuses before any socket opens); the app
  // already holds the offline flag, so the tab tells the truth without a round-trip.
  const airgapped = () => (serverSync().data.config as { offline?: { enabled?: boolean } }).offline?.enabled === true

  // One honest line: what search actually does right now, in the order the service decides it.
  const statusLine = () =>
    airgapped()
      ? language.t("settings.webSearch.status.airgapped")
      : usingSearxng()
        ? language.t("settings.webSearch.status.searxng")
        : language.t("settings.webSearch.status.builtin")

  async function persist(patch: Partial<WebSearchConfig>) {
    const next = { ...current(), ...patch }
    await serverSync()
      .updateConfig({ web_search: next } as never)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("settings.webSearch.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const throttle = (): ThrottleConfig => current().throttle ?? {}

  // A blank field means "use the default". ⚠️ Deleting the key does NOT work: config writes are a MERGE
  // patch, so an omitted key merges rather than deletes and the old value survives (verified live). The
  // codebase convention is a sentinel — write `0`, which `fetch-pace.ts` treats as unset.
  const persistThrottle = (key: keyof ThrottleConfig, raw: string) => {
    const trimmed = raw.trim()
    const value = trimmed === "" ? 0 : Number(trimmed)
    if (!Number.isFinite(value) || value < 0) return
    return persist({ throttle: { ...throttle(), [key]: value } })
  }

  /** 0 is the "unset" sentinel, so render it as an empty box showing the default placeholder. */
  const fieldValue = (key: keyof ThrottleConfig) => {
    const value = throttle()[key]
    return value === undefined || value <= 0 ? "" : String(value)
  }

  const toggleEngine = (id: string, enabled: boolean) => {
    const disabled = new Set(current().disabledEngines ?? [])
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    return persist({ disabledEngines: [...disabled] })
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.webSearch.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.webSearch.description")}</p>
      </div>

      <p class="settings-v2-field-description" classList={{ "settings-v2-server-dialog-error": airgapped() }}>
        {language.t("settings.webSearch.status")}: {statusLine()}
      </p>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.webSearch.row.searxng.title")}
          description={language.t("settings.webSearch.row.searxng.description")}
        >
          <TextInputV2
            type="text"
            appearance="large"
            class="!w-full self-stretch"
            value={current().searxngUrl ?? ""}
            placeholder="http://localhost:8080"
            spellcheck={false}
            autocomplete="off"
            onChange={(event) => void persist({ searxngUrl: event.currentTarget.value.trim() })}
          />
        </SettingsRowV2>
      </SettingsListV2>

      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.webSearch.builtin.title")}</h3>
        <p class="settings-v2-field-description">
          {usingSearxng() ? language.t("settings.webSearch.builtin.overridden") : language.t("settings.webSearch.builtin.description")}
        </p>
        <SettingsListV2>
          <Show when={!usingSearxng()} fallback={null}>
            {BUILTIN_ENGINES.map((engine) => (
              <SettingsRowV2 title={engine.label} description={language.t("settings.webSearch.builtin.engineHint")}>
                <Switch
                  checked={!(current().disabledEngines ?? []).includes(engine.id)}
                  onChange={(checked) => void toggleEngine(engine.id, checked)}
                  aria-label={engine.label}
                />
              </SettingsRowV2>
            ))}
          </Show>
        </SettingsListV2>
      </div>

      {/* The traffic governor. Whole tab is Advanced+ (TAB_LEVELS "web-search": "advanced"), so these
          are already hidden from a normal user — but they are the one surface here that can cause real
          harm, so the warning is explicit rather than implied. */}
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.webSearch.throttle.title")}</h3>
        <p class="settings-v2-field-description">{language.t("settings.webSearch.throttle.description")}</p>
        <p class="settings-v2-field-description settings-v2-server-dialog-error">
          {language.t("settings.webSearch.throttle.warning")}
        </p>
        <SettingsListV2>
          {THROTTLE_FIELDS.map((field) => (
            <SettingsRowV2 title={language.t(field.label)} description={language.t(field.hint)}>
              <TextInputV2
                type="number"
                appearance="large"
                min={field.min}
                class="!w-32 self-stretch"
                value={fieldValue(field.key)}
                placeholder={String(field.fallback)}
                spellcheck={false}
                autocomplete="off"
                onChange={(event) => void persistThrottle(field.key, event.currentTarget.value)}
              />
            </SettingsRowV2>
          ))}
        </SettingsListV2>
      </div>
    </>
  )
}
