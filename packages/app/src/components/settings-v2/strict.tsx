import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// The Strict-mode settings tab (taxonomy E6 — every JH option user-surfaced). Strict mode is the
// Juvenile Harness posture for weak/local models (jh.md): the HARNESS owns decomposition, per-step
// compile/test verification, external correction, and recovery — the model is never asked to hold the
// whole horizon. This tab edits the `strict` config the harness reads (its group toggles map onto the
// engine lever families; see core/src/config/strict.ts). Patch-merge semantics as in the Affective tab.

interface StrictConfig {
  enabled?: boolean
  verification?: boolean
  recovery?: boolean
  editingAids?: boolean
  budgetSteering?: boolean
  wallMinutes?: number
}

const DEFAULT_WALL_MINUTES = 45
// The lever groups all default ON inside the engine — the switches show that default until overridden.
const GROUPS = ["verification", "recovery", "editingAids", "budgetSteering"] as const

export const SettingsStrictV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const current = (): StrictConfig => ((serverSync().data.config as { strict?: StrictConfig }).strict ?? {})

  async function persist(patch: Partial<StrictConfig>) {
    const next = { ...current(), ...patch }
    for (const key of Object.keys(next) as Array<keyof StrictConfig>)
      if (next[key] === undefined) delete next[key]
    await serverSync()
      .updateConfig({ strict: next } as never)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("settings.strict.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.strict.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.strict.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.strict.row.enabled.title")}
              description={language.t("settings.strict.row.enabled.description")}
            >
              <Switch checked={current().enabled === true} onChange={(checked) => void persist({ enabled: checked })} hideLabel>
                {language.t("settings.strict.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            {GROUPS.map((group) => (
              <SettingsRowV2
                title={language.t(`settings.strict.row.${group}.title`)}
                description={language.t(`settings.strict.row.${group}.description`)}
              >
                <Switch
                  checked={current()[group] !== false}
                  onChange={(checked) => void persist({ [group]: checked ? undefined : false })}
                  hideLabel
                >
                  {language.t(`settings.strict.row.${group}.title`)}
                </Switch>
              </SettingsRowV2>
            ))}

            <SettingsRowV2
              title={language.t("settings.strict.row.wallMinutes.title")}
              description={language.t("settings.strict.row.wallMinutes.description")}
            >
              <div class="w-full sm:w-[100px]">
                <TextInputV2
                  type="number"
                  appearance="base"
                  min="1"
                  max="480"
                  step="1"
                  value={current().wallMinutes || ""}
                  placeholder={String(DEFAULT_WALL_MINUTES)}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.currentTarget.value, 10)
                    void persist({ wallMinutes: Number.isFinite(parsed) && parsed > 0 ? parsed : 0 })
                  }}
                  aria-label={language.t("settings.strict.row.wallMinutes.title")}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
