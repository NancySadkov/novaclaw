import { Persona } from "@novaclaw/core/persona"
import { ContextTemplate } from "@novaclaw/core/session/context-template"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"
import { For, Show, type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"
import { SLOT_ORIGIN } from "./context-layout"

// B4 — the System Prompt settings tab, and (owner, 2026-09-16) the ONE place the prompt LAYOUT is
// legible. It exposes the composed prompt's editable layers — the role-neutral persona baseline — and
// renders `ContextTemplate.SLOTS` in order, so "where does everything go" is answered by the screen
// instead of by reading five files.
//
// ⚠️ The layout table is IMPORTED from the kernel, never transcribed. A hand-written copy of the block
// list in the client is the defect this page exists to end (`SystemAccounting.BLOCKS` was one, and it
// had already gone stale), and `context-template.ts` is a pure table with no imports, so rendering it
// here costs the client nothing and cannot drift.

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

/**
 * `placement` is optional PER SLOT, so the kernel's array is a tuple in which the member without it
 * has no such property — reading `slot.placement` on the union is a type error, and `as` at the call
 * site would hide a genuine rename. This one accessor is the whole cost of keeping the field optional
 * where it belongs.
 */
const placementOf = (slot: (typeof ContextTemplate.SLOTS)[number]): string | undefined =>
  "placement" in slot ? (slot.placement as string | undefined) : undefined

export const SettingsSystemPromptV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const config = () =>
    serverSync().data.config as {
      persona?: PersonaConfig
    }
  const persona = (): PersonaConfig => config().persona ?? {}

  const failed = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.systemPrompt.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  // updateGlobal patch-MERGES records (cleared string fields persist as "" — the resolvers treat empty
  // as use-the-default).
  async function persistPersona(patch: Partial<PersonaConfig>) {
    const next = { ...persona(), ...patch }
    await serverSync()
      .updateConfig({ persona: next } as never)
      .catch(failed)
  }

  const slotLabel = (name: string) => language.t(`settings.contextLayout.slot.${name}` as never) || name

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
              info={language.t("settings.systemPrompt.persona.enabled.description.more")}
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

        {/*
          🔴 THE LAYOUT (owner, 2026-09-16: *"clearly exposing the layout in UI, while allowing user to
          both view and edit it"*). It is the kernel's own table, in order, with the two facts a reader
          cannot get from anywhere else today: WHERE each part comes from, and HOW LONG it survives.
        */}
        <div class="settings-v2-section" data-component="settings-context-layout">
          <h3 class="settings-v2-section-title">{language.t("settings.contextLayout.title")}</h3>
          <p class="settings-v2-field-description">
            {language.t("settings.contextLayout.description", { count: String(ContextTemplate.SLOTS.length) })}
            <SettingsExplainV2 label={language.t("settings.contextLayout.title")}>
              {language.t("settings.contextLayout.description.more")}
            </SettingsExplainV2>
          </p>

          <SettingsListV2>
            <For each={ContextTemplate.SLOTS}>
              {(slot) => (
                <SettingsRowV2
                  title={slotLabel(slot.name)}
                  info={
                    <>
                      {slot.purpose}
                      <Show when={placementOf(slot)}>{(placement) => <> {placement()}</>}</Show>
                      <span class="block mt-1 text-[11px] text-v2-text-text-faint">
                        {language.t(`settings.contextLayout.channel.${slot.channel}` as never)} ·{" "}
                        {language.t(`settings.contextLayout.volatility.${slot.volatility}` as never)}
                      </span>
                    </>
                  }
                >
                  <span
                    class="text-[11px] text-v2-text-text-muted"
                    data-slot-origin={SLOT_ORIGIN[slot.name] ?? "auto"}
                  >
                    {language.t(`settings.contextLayout.origin.${SLOT_ORIGIN[slot.name] ?? "auto"}` as never)}
                  </span>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
