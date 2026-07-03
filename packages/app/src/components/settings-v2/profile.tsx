import { type Component, createMemo } from "solid-js"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// The Profile tab — the friendly, normal-level home for "who am I". The user types their name and a
// short "about me"; the Enable switch is the master consent gate. When enabled, the model can look the
// profile up ON DEMAND through the `profile` tool (core/tool/profile.ts) instead of it always sitting
// in the prompt — off means the assistant never sees it. Persisting goes through updateConfig, which
// patch-merges the user_profile record into the global novaclaw.jsonc (see AGENTS.md config notes).

interface UserProfileConfig {
  enabled?: boolean
  name?: string
  about?: string
}

export const SettingsProfileV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const profile = createMemo<UserProfileConfig>(
    () => (serverSync().data.config as { user_profile?: UserProfileConfig }).user_profile ?? {},
  )
  // Opt-out: a filled profile is shared unless explicitly switched off (so profiles set before this
  // switch existed keep working, and the friendly default is that your local assistant knows you).
  const enabled = () => profile().enabled !== false

  const failed = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.profile.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  async function persistProfile(patch: Partial<UserProfileConfig>) {
    const next = { ...profile(), ...patch }
    await serverSync()
      .updateConfig({ user_profile: next } as never)
      .catch(failed)
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.profile.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.profile.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.profile.enabled.title")}
              description={language.t("settings.profile.enabled.description")}
            >
              <div data-action="settings-profile-enabled">
                <Switch checked={enabled()} onChange={(checked) => void persistProfile({ enabled: checked })} hideLabel>
                  {language.t("settings.profile.enabled.title")}
                </Switch>
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.profile.name.title")}
              description={language.t("settings.profile.name.description")}
            >
              <div class="w-full sm:w-[220px]">
                <TextInputV2
                  type="text"
                  appearance="base"
                  value={profile().name ?? ""}
                  placeholder={language.t("settings.profile.name.placeholder")}
                  spellcheck={false}
                  autocomplete="off"
                  data-action="settings-profile-name"
                  onChange={(event) => void persistProfile({ name: event.currentTarget.value.trim() })}
                  aria-label={language.t("settings.profile.name.title")}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>

          <p class="settings-v2-field-description">{language.t("settings.profile.about.description")}</p>
          <TextareaV2
            class="settings-v2-textarea"
            rows={5}
            value={profile().about ?? ""}
            placeholder={language.t("settings.profile.about.placeholder")}
            spellcheck={false}
            data-action="settings-profile-about"
            onChange={(event) => void persistProfile({ about: event.currentTarget.value.trim() })}
            aria-label={language.t("settings.profile.about.title")}
          />
        </div>
      </div>
    </>
  )
}
