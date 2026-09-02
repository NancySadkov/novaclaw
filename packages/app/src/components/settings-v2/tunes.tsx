import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { For, Show, type Component } from "solid-js"
import { useExpertise } from "@/context/expertise"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsNumberFieldV2 } from "./parts/number-field"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"

type ContextCategory = "system" | "messages" | "retrieval" | "memory" | "tool_output"
type ContextProfileName = "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
type ContextProfile = Partial<Record<ContextCategory, number>>
interface ContextConfig {
  enabled?: boolean
  profiles?: Partial<Record<ContextProfileName, ContextProfile>>
  todo_reminder?: {
    enabled?: boolean
    cadence?: number
    max_tokens?: number
  }
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
  const reminderCadence = () => current().todo_reminder?.cadence ?? 6
  const reminderBudget = () => current().todo_reminder?.max_tokens ?? 256

  const persist = (next: ContextConfig) =>
    reportedWrite(
      () => serverSync().updateConfig({ context: next }),
      (error) => showToast({ variant: "error", title: language.t("settings.tunes.toast.failed"), description: error }),
    )

  const setShare = (profile: ContextProfileName, category: ContextCategory, value: number) => {
    const nextProfile = { ...current().profiles?.[profile], [category]: value }
    void persist({
      ...current(),
      profiles: { ...current().profiles, [profile]: nextProfile },
    })
  }

  const setReminder = (patch: NonNullable<ContextConfig["todo_reminder"]>) => {
    void persist({
      ...current(),
      todo_reminder: { ...current().todo_reminder, ...patch },
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
              description={
                <>
                  {language.t("settings.tunes.context.enabled.description")}
                  <SettingsExplainV2 label={language.t("settings.tunes.context.enabled.title")}>
                    {language.t("settings.tunes.context.enabled.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <Switch
                checked={current().enabled !== false}
                onChange={(checked) => void persist({ ...current(), enabled: checked })}
                hideLabel
              >
                {language.t("settings.tunes.context.enabled.title")}
              </Switch>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.tunes.todo.enabled.title")}
              description={language.t("settings.tunes.todo.enabled.description")}
            >
              <Switch
                checked={current().todo_reminder?.enabled !== false}
                onChange={(checked) => setReminder({ enabled: checked })}
                hideLabel
              >
                {language.t("settings.tunes.todo.enabled.title")}
              </Switch>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.tunes.todo.cadence.title")}
              description={language.t("settings.tunes.todo.cadence.description")}
            >
              <SettingsNumberFieldV2
                class="settings-v2-tunes-input"
                value={() => reminderCadence()}
                onCommit={(cadence) => setReminder({ cadence })}
                min={1}
                max={1000}
                unit="msg"
                ariaLabel={language.t("settings.tunes.todo.cadence.title")}
              />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.tunes.todo.budget.title")}
              description={language.t("settings.tunes.todo.budget.description")}
            >
              <SettingsNumberFieldV2
                class="settings-v2-tunes-input"
                value={() => reminderBudget()}
                onCommit={(max_tokens) => setReminder({ max_tokens })}
                min={64}
                max={4096}
                step={16}
                unit="tok"
                ariaLabel={language.t("settings.tunes.todo.budget.title")}
              />
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
                          <SettingsNumberFieldV2
                            class="settings-v2-tunes-input"
                            value={() => share(profile, category)}
                            onCommit={(value) => setShare(profile, category, value)}
                            min={0}
                            max={100}
                            unit="%"
                            ariaLabel={`${language.t(`settings.tunes.profile.${profile}`)} — ${language.t(
                              `settings.tunes.category.${category}`,
                            )}`}
                          />
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
