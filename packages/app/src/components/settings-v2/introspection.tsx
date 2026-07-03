import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// P2 (2D) — the Introspection settings tab. A cadence-gated judge model watches a running
// session and steers an interjection when it answers "yes, this agent is stuck" (2A/2B).
// This tab edits the 2C config (`introspection` on the global novaclaw.jsonc). Persisting
// MUST go through serverSync().updateConfig — a bare set("config", …) is a no-op (the
// golden config-write rule). Defaults mirror core/session/runner/introspection.ts.

interface IntrospectionConfig {
  enabled?: boolean
  cadence?: number
  model?: string
  prompt?: string
  interjection?: string
  generateInterjection?: boolean
}

// Placeholders mirror the runner's canonical defaults so an empty field shows what runs.
const DEFAULT_CADENCE = 3
const DEFAULT_PROMPT =
  "You are auditing another AI agent's work-in-progress. Judge ONLY whether the agent is stuck: " +
  "looping over the same actions, repeating failed attempts without changing approach, or making no " +
  "progress toward the task. Answer with a single word — YES if it is stuck or looping and needs an " +
  "interjection to force a change of course now, NO otherwise."
const DEFAULT_INTERJECTION =
  "You appear to be stuck or looping. Stop repeating the same approach — take ONE concrete, different " +
  "action now, or ask the user a specific question."

export const SettingsIntrospectionV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const current = (): IntrospectionConfig =>
    ((serverSync().data.config as { introspection?: IntrospectionConfig }).introspection ?? {})

  async function persist(patch: Partial<IntrospectionConfig>) {
    // updateGlobal patch-MERGES (a key can never be removed over the wire — undefined doesn't
    // survive JSON, null breaks the schema), so a cleared field is written as ""/0, which the
    // runner's resolve() already treats as "use the default" (its ||-chains and the >=1 guard).
    const next = { ...current(), ...patch }
    for (const key of Object.keys(next) as Array<keyof IntrospectionConfig>)
      if (next[key] === undefined) delete next[key]
    await serverSync()
      .updateConfig({ introspection: next } as never)
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("settings.introspection.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.introspection.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.introspection.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.introspection.row.enabled.title")}
              description={language.t("settings.introspection.row.enabled.description")}
            >
              <Switch
                checked={current().enabled === true}
                onChange={(checked) => void persist({ enabled: checked })}
                hideLabel
              >
                {language.t("settings.introspection.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.introspection.row.cadence.title")}
              description={language.t("settings.introspection.row.cadence.description")}
            >
              <div class="w-full sm:w-[100px]">
                <TextInputV2
                  type="number"
                  appearance="base"
                  min="1"
                  value={current().cadence || ""}
                  placeholder={String(DEFAULT_CADENCE)}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.currentTarget.value, 10)
                    void persist({ cadence: Number.isFinite(parsed) && parsed >= 1 ? parsed : 0 })
                  }}
                  aria-label={language.t("settings.introspection.row.cadence.title")}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.introspection.row.model.title")}
              description={language.t("settings.introspection.row.model.description")}
            >
              <div class="w-full sm:w-[260px]">
                <TextInputV2
                  type="text"
                  appearance="base"
                  value={current().model ?? ""}
                  placeholder={language.t("settings.introspection.row.model.placeholder")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  onChange={(event) => void persist({ model: event.currentTarget.value.trim() })}
                  aria-label={language.t("settings.introspection.row.model.title")}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.introspection.row.generate.title")}
              description={language.t("settings.introspection.row.generate.description")}
            >
              <Switch
                checked={current().generateInterjection === true}
                onChange={(checked) => void persist({ generateInterjection: checked })}
                hideLabel
              >
                {language.t("settings.introspection.row.generate.title")}
              </Switch>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.introspection.row.prompt.title")}</h3>
          <p class="settings-v2-field-description">{language.t("settings.introspection.row.prompt.description")}</p>
          <TextareaV2
            class="settings-v2-textarea"
            rows={5}
            value={current().prompt ?? ""}
            placeholder={DEFAULT_PROMPT}
            spellcheck={false}
            onChange={(event) => void persist({ prompt: event.currentTarget.value.trim() })}
            aria-label={language.t("settings.introspection.row.prompt.title")}
          />
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.introspection.row.interjection.title")}</h3>
          <p class="settings-v2-field-description">
            {language.t("settings.introspection.row.interjection.description")}
          </p>
          <TextareaV2
            class="settings-v2-textarea"
            rows={4}
            value={current().interjection ?? ""}
            placeholder={DEFAULT_INTERJECTION}
            spellcheck={false}
            onChange={(event) => void persist({ interjection: event.currentTarget.value.trim() })}
            aria-label={language.t("settings.introspection.row.interjection.title")}
          />
        </div>
      </div>
    </>
  )
}
