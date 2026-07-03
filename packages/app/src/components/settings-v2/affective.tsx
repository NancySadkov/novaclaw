import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// P3 (3D) — the Affective settings tab. When enabled, a per-session mood (appraised from tool
// errors, repeats, time-on-task) modulates sampling around the model's configured baseline and
// steers a redirect at high frustration/urgency (3A/3B). Edits the 3C `affective` config.
// Same field-clearing semantics as the Introspection tab: updateGlobal patch-merges, so a
// cleared temperature writes 0, which the engine treats as "unset" (falls to its default).

interface AffectiveConfig {
  enabled?: boolean
  temperature?: number
  extended?: boolean
}

const DEFAULT_TEMPERATURE = 0.7

export const SettingsAffectiveV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const current = (): AffectiveConfig =>
    ((serverSync().data.config as { affective?: AffectiveConfig }).affective ?? {})

  async function persist(patch: Partial<AffectiveConfig>) {
    const next = { ...current(), ...patch }
    for (const key of Object.keys(next) as Array<keyof AffectiveConfig>)
      if (next[key] === undefined) delete next[key]
    await serverSync()
      .updateConfig({ affective: next } as never)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("settings.affective.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.affective.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.affective.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.affective.row.enabled.title")}
              description={language.t("settings.affective.row.enabled.description")}
            >
              <Switch
                checked={current().enabled === true}
                onChange={(checked) => void persist({ enabled: checked })}
                hideLabel
              >
                {language.t("settings.affective.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.affective.row.temperature.title")}
              description={language.t("settings.affective.row.temperature.description")}
            >
              <div class="w-full sm:w-[100px]">
                <TextInputV2
                  type="number"
                  appearance="base"
                  min="0"
                  max="2"
                  step="0.05"
                  value={current().temperature || ""}
                  placeholder={String(DEFAULT_TEMPERATURE)}
                  onChange={(event) => {
                    const parsed = Number.parseFloat(event.currentTarget.value)
                    void persist({ temperature: Number.isFinite(parsed) && parsed > 0 ? parsed : 0 })
                  }}
                  aria-label={language.t("settings.affective.row.temperature.title")}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.affective.row.extended.title")}
              description={language.t("settings.affective.row.extended.description")}
            >
              <Switch
                checked={current().extended === true}
                onChange={(checked) => void persist({ extended: checked })}
                hideLabel
              >
                {language.t("settings.affective.row.extended.title")}
              </Switch>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
