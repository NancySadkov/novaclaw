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

// B4 — the System Prompt settings tab. Exposes the composed prompt's EDITABLE
// layers: (1) persona — rename the agent (Nova→anything) + replace the B3 base
// prompt wholesale; (2) project instructions — the `instructions[]` paths/URLs
// already honored by the runtime, surfaced here. (The user profile lives in its
// own Profile tab now — it's delivered on demand via the `profile` tool, not
// injected here.) The shipped base stays immutable: editing here writes CONFIG
// overrides (persona.prompt replaces at compose time; clearing the field
// restores the canonical default). Persisting MUST go through updateConfig.

interface PersonaConfig {
  enabled?: boolean
  name?: string
  prompt?: string
}

// Placeholder mirrors core/src/persona.ts defaultPrompt() so an empty field
// shows what actually runs (the introspection-tab convention).
const defaultPersonaPrompt = (name: string) =>
  [
    `You're a pragmatic and highly capable software engineer, ${name}. Your responses are honest, direct, raw, and concise. Don't bury the user in walls of text unless they explicitly ask you to elaborate — maintain maximum signal-to-noise. If the user proposes something irrational, push back with constructive criticism, offer better solutions, and name the pitfalls; but if they persist and confirm, proceed — assume they know better and that you're skilled enough for any scale. If a prompt is ambiguous, ask for clarification.`,
    `Formatting: no bullet or numbered lists by default — clean, direct paragraphs; use a list only if explicitly requested, or for a sequence so complex a paragraph would be unreadable. Keep responses raw, concise, and scannable via brief paragraphs and bold emphasis.`,
    `Before writing or modifying code, research first and break the problem into manageable steps. Prefer small, surgical edits to existing files over rewriting them — make the minimal change (insert the one line you need) instead of regenerating a whole file; full rewrites waste tokens and introduce regressions. Always test what you write where possible, or clearly tell the user you couldn't and why.`,
  ].join("\n\n")

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
              description={language.t("settings.systemPrompt.persona.enabled.description")}
            >
              <Switch
                checked={persona().enabled !== false}
                onChange={(checked) => void persistPersona({ enabled: checked })}
                hideLabel
              >
                {language.t("settings.systemPrompt.persona.enabled.title")}
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.systemPrompt.persona.name.title")}
              description={language.t("settings.systemPrompt.persona.name.description")}
            >
              <div class="w-full sm:w-[200px]">
                <TextInputV2
                  type="text"
                  appearance="base"
                  value={persona().name ?? ""}
                  placeholder="Nova"
                  spellcheck={false}
                  autocomplete="off"
                  onChange={(event) => void persistPersona({ name: event.currentTarget.value.trim() })}
                  aria-label={language.t("settings.systemPrompt.persona.name.title")}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>

          <p class="settings-v2-field-description">{language.t("settings.systemPrompt.persona.prompt.description")}</p>
          <TextareaV2
            class="settings-v2-textarea"
            rows={7}
            value={persona().prompt ?? ""}
            placeholder={defaultPersonaPrompt(persona().name?.trim() || "Nova")}
            spellcheck={false}
            onChange={(event) => void persistPersona({ prompt: event.currentTarget.value.trim() })}
            aria-label={language.t("settings.systemPrompt.persona.prompt.title")}
          />
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.systemPrompt.instructions.title")}</h3>
          <p class="settings-v2-field-description">
            {language.t("settings.systemPrompt.instructions.description")}
          </p>
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
