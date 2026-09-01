import { Persona } from "@novaclaw/core/persona"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"

// B4 — the System Prompt settings tab. Exposes the composed prompt's EDITABLE
// layers: (1) the role-neutral B3 approach baseline; (2) project instructions —
// the `instructions[]` paths/URLs
// already honored by the runtime, surfaced here. (The user profile lives in its
// own Profile tab now — it's delivered on demand via the `profile` tool, not
// injected here.) The shipped base stays immutable: editing here writes CONFIG
// overrides (persona.prompt replaces at compose time; clearing the field
// restores the canonical default). Persisting MUST go through updateConfig.

interface PersonaConfig {
  enabled?: boolean
  prompt?: string
}

/**
 * The placeholder is the RUNNING default, imported — not a copy of it.
 *
 * It used to be a hand-typed transcription under a comment saying it "mirrors core/src/persona.ts
 * defaultPrompt() so an empty field shows what actually runs". All three paragraphs had drifted, so
 * the one field whose empty state is documented as showing the composed default was showing a prompt
 * the instance does not use — to a user reading it in order to decide whether to override it.
 *
 * `persona.ts` is pure and dependency-free, and `storage.tsx` already sets the precedent for
 * value-importing a core constant into user-facing copy rather than retyping it.
 */
const defaultPersonaPrompt = Persona.defaultPrompt

export const SettingsSystemPromptV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const config = () =>
    serverSync().data.config as {
      persona?: PersonaConfig
      instructions?: string[]
    }
  const persona = (): PersonaConfig => config().persona ?? {}
  const instructions = (): string[] => config().instructions ?? []

  const failed = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.systemPrompt.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  // updateGlobal patch-MERGES records (cleared string fields persist as "" — the
  // resolvers treat empty as use-the-default), while ARRAYS replace wholesale
  // (patchJsonc), which is exactly what the instructions editor needs.
  async function persistPersona(patch: Partial<PersonaConfig>) {
    const next = { ...persona(), ...patch }
    await serverSync()
      .updateConfig({ persona: next } as never)
      .catch(failed)
  }

  async function persistInstructions(lines: string[]) {
    await serverSync()
      .updateConfig({ instructions: lines } as never)
      .catch(failed)
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.systemPrompt.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.systemPrompt.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.systemPrompt.persona.title")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.systemPrompt.persona.enabled.title")}
              description={
                <>
                  {language.t("settings.systemPrompt.persona.enabled.description")}
                  <SettingsExplainV2 label={language.t("settings.systemPrompt.persona.enabled.title")}>
                    {language.t("settings.systemPrompt.persona.enabled.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <Switch
                checked={persona().enabled !== false}
                onChange={(checked) => void persistPersona({ enabled: checked })}
                hideLabel
              >
                {language.t("settings.systemPrompt.persona.enabled.title")}
              </Switch>
            </SettingsRowV2>
          </SettingsListV2>

          <p class="settings-v2-field-description">{language.t("settings.systemPrompt.persona.prompt.description")}</p>
          <TextareaV2
            class="settings-v2-textarea"
            rows={7}
            value={persona().prompt ?? ""}
            placeholder={defaultPersonaPrompt()}
            spellcheck={false}
            onChange={(event) => void persistPersona({ prompt: event.currentTarget.value.trim() })}
            aria-label={language.t("settings.systemPrompt.persona.prompt.title")}
          />
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.systemPrompt.instructions.title")}</h3>
          <p class="settings-v2-field-description">{language.t("settings.systemPrompt.instructions.description")}</p>
          <TextareaV2
            class="settings-v2-textarea"
            rows={3}
            value={instructions().join("\n")}
            placeholder={language.t("settings.systemPrompt.instructions.placeholder")}
            spellcheck={false}
            onChange={(event) =>
              void persistInstructions(
                event.currentTarget.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
              )
            }
            aria-label={language.t("settings.systemPrompt.instructions.title")}
          />
        </div>
      </div>
    </>
  )
}
