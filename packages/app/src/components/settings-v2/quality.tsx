import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// QE-D — the Quality Enforcement settings tab. Edits the QE-C config: the
// provisioned check commands the runner executes at write/turn boundaries, the
// typecheck cadence, and the test-gate timeout. Empty command = that step is
// skipped ("not everything has an automatic check"). Persist via updateConfig
// (the golden config-write rule); cleared fields write "" which resolve()
// treats as unset. QE-A (SHIPPED) lets the model provision these itself via the
// quality_provision tool (manifest scan → verify → write project novaclaw.jsonc);
// this tab is the manual path + where you review/override what QE-A wrote.

interface QualityCommands {
  syntax?: string
  check?: string
  typecheck?: string
  test?: string
  lint?: string
}

interface QualityConfig {
  enabled?: boolean
  cadence?: number
  testTimeout?: number
  commands?: QualityCommands
}

const COMMAND_FIELDS: Array<{ key: keyof QualityCommands; placeholder: string }> = [
  { key: "syntax", placeholder: "bun build --no-bundle {file}" },
  { key: "check", placeholder: "eslint {file}" },
  { key: "typecheck", placeholder: "tsc -b --noEmit" },
  { key: "test", placeholder: "bun test" },
  { key: "lint", placeholder: "biome check ." },
]

export const SettingsQualityV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const current = (): QualityConfig => ((serverSync().data.config as { quality?: QualityConfig }).quality ?? {})

  async function persist(patch: Partial<QualityConfig>) {
    const next = { ...current(), ...patch }
    await serverSync()
      .updateConfig({ quality: next } as never)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("settings.quality.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const persistCommand = (key: keyof QualityCommands, value: string) =>
    persist({ commands: { ...(current().commands ?? {}), [key]: value.trim() } })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.quality.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.quality.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.quality.row.enabled.title")}
              description={language.t("settings.quality.row.enabled.description")}
            >
              <Switch checked={current().enabled === true} onChange={(checked) => void persist({ enabled: checked })} hideLabel>
                {language.t("settings.quality.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.quality.row.cadence.title")}
              description={language.t("settings.quality.row.cadence.description")}
            >
              <div class="w-full sm:w-[100px]">
                <TextInputV2
                  type="number"
                  appearance="base"
                  min="1"
                  value={current().cadence || ""}
                  placeholder="2"
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.currentTarget.value, 10)
                    void persist({ cadence: Number.isFinite(parsed) && parsed >= 1 ? parsed : 0 })
                  }}
                  aria-label={language.t("settings.quality.row.cadence.title")}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.quality.row.testTimeout.title")}
              description={language.t("settings.quality.row.testTimeout.description")}
            >
              <div class="w-full sm:w-[140px]">
                <TextInputV2
                  type="number"
                  appearance="base"
                  min="1000"
                  value={current().testTimeout || ""}
                  placeholder="300000"
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.currentTarget.value, 10)
                    void persist({ testTimeout: Number.isFinite(parsed) && parsed >= 1000 ? parsed : 0 })
                  }}
                  aria-label={language.t("settings.quality.row.testTimeout.title")}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.quality.commands.title")}</h3>
          <p class="settings-v2-field-description">{language.t("settings.quality.commands.description")}</p>
          <SettingsListV2>
            {COMMAND_FIELDS.map((field) => (
              <SettingsRowV2
                title={language.t(`settings.quality.command.${field.key}.title`)}
                description={language.t(`settings.quality.command.${field.key}.description`)}
              >
                <div class="w-full sm:w-[320px]">
                  <TextInputV2
                    type="text"
                    appearance="base"
                    value={current().commands?.[field.key] ?? ""}
                    placeholder={field.placeholder}
                    spellcheck={false}
                    autocomplete="off"
                    onChange={(event) => void persistCommand(field.key, event.currentTarget.value)}
                    aria-label={language.t(`settings.quality.command.${field.key}.title`)}
                  />
                </div>
              </SettingsRowV2>
            ))}
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
