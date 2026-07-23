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

interface WebSearchConfig {
  searxngUrl?: string
  disabledEngines?: string[]
  timeoutMs?: number
}

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
    </>
  )
}
