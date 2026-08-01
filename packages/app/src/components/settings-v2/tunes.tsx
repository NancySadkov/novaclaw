import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { For, Show, type Component } from "solid-js"
import { useExpertise } from "@/context/expertise"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ContextCategory = "system" | "messages" | "retrieval" | "memory" | "tool_output"
type ContextProfileName = "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
type ContextProfile = Partial<Record<ContextCategory, number>>
interface ContextConfig {
  enabled?: boolean
  profiles?: Partial<Record<ContextProfileName, ContextProfile>>
}

const PROFILE_NAMES: readonly ContextProfileName[] = ["interactive", "sub-agent", "auto-prompting", "goal-oriented"]
const CATEGORIES: readonly ContextCategory[] = ["system", "messages", "retrieval", "memory", "tool_output"]
const DEFAULTS: Readonly<Record<ContextProfileName, Readonly<Record<ContextCategory, number>>>> = {
  interactive: { system: 25, messages: 40, retrieval: 10, memory: 5, tool_output: 20 },
  "sub-agent": { system: 25, messages: 30, retrieval: 10, memory: 5, tool_output: 30 },
  "auto-prompting": { system: 20, messages: 25, retrieval: 10, memory: 5, tool_output: 40 },
  "goal-oriented": { system: 20, messages: 25, retrieval: 10, memory: 5, tool_output: 40 },
}

/** A5/A2.1 — Settings owns the instance baseline for the context-budget Tune. Advanced users see
 * the automatic thread-type profiles; Developer mode unlocks their raw share ceilings. The runner
 * reads this store for every turn, so every successful save applies without a restart. */
export const SettingsTunesV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const { atLeast } = useExpertise()

  const current = (): ContextConfig => (serverSync().data.config as { context?: ContextConfig }).context ?? {}
  const share = (profile: ContextProfileName, category: ContextCategory) =>
    current().profiles?.[profile]?.[category] ?? DEFAULTS[profile][category]

  async function persist(next: ContextConfig) {
    await serverSync()
      .updateConfig({ context: next })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("settings.tunes.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const setShare = (profile: ContextProfileName, category: ContextCategory, value: number) => {
    const nextProfile = { ...current().profiles?.[profile], [category]: value }
    void persist({
      ...current(),
      profiles: { ...current().profiles, [profile]: nextProfile },
    })
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.tunes.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.tunes.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.tunes.context.enabled.title")}
              description={language.t("settings.tunes.context.enabled.description")}
            >
              <Switch
                checked={current().enabled !== false}
                onChange={(checked) => void persist({ ...current(), enabled: checked })}
                hideLabel
              >
                {language.t("settings.tunes.context.enabled.title")}
              </Switch>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section settings-v2-tunes-profiles">
          <h3 class="settings-v2-section-title">{language.t("settings.tunes.profiles.title")}</h3>
          <p class="settings-v2-field-description">{language.t("settings.tunes.profiles.description")}</p>
          <For each={PROFILE_NAMES}>
            {(profile) => (
              <div class="settings-v2-tunes-profile" data-context-profile={profile}>
                <div class="settings-v2-tunes-profile-header">
                  <span class="settings-v2-tunes-profile-title">{language.t(`settings.tunes.profile.${profile}`)}</span>
                  <span class="settings-v2-tunes-profile-total">
                    {language.t("settings.tunes.profile.total", {
                      total: CATEGORIES.reduce((sum, category) => sum + share(profile, category), 0),
                    })}
                  </span>
                </div>
                <SettingsListV2>
                  <For each={CATEGORIES}>
                    {(category) => (
                      <SettingsRowV2
                        title={language.t(`settings.tunes.category.${category}`)}
                        description={language.t(`settings.tunes.category.${category}.description`)}
                      >
                        <Show
                          when={atLeast("developer")}
                          fallback={<span class="settings-v2-tunes-share">{share(profile, category)}%</span>}
                        >
                          <div class="settings-v2-tunes-input">
                            <TextInputV2
                              type="number"
                              appearance="base"
                              min="0"
                              max="100"
                              step="1"
                              value={share(profile, category)}
                              onInput={(event) => {
                                const parsed = Number.parseInt(event.currentTarget.value, 10)
                                if (Number.isFinite(parsed))
                                  setShare(profile, category, Math.max(0, Math.min(100, parsed)))
                              }}
                              aria-label={`${language.t(`settings.tunes.profile.${profile}`)} — ${language.t(
                                `settings.tunes.category.${category}`,
                              )}`}
                            />
                            <span aria-hidden="true">%</span>
                          </div>
                        </Show>
                      </SettingsRowV2>
                    )}
                  </For>
                </SettingsListV2>
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  )
}
