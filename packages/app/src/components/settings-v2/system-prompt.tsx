import { ContextTemplate } from "@novaclaw/core/session/context-template"
import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"
import { SLOT_ORIGIN } from "./context-layout"

// The prompt LAYOUT tab — where the composed prompt is legible, block by block.
//
// 🔴 Owner, 2026-09-17: the shared "persona baseline" editor that used to head this tab is GONE. The
// working style is no longer a global block composed around every agent's prompt; it is the officer's
// own prompt (`officer-prompt.ts`, Settings → the colleague → Job instructions). A global identity
// that every role had to wear — including a roleplayer, a chat companion or an artist — was the defect.
//
// What remains is the half that never contradicted anything: `ContextTemplate.SLOTS`, the kernel's own
// ordered table, rendered so "where does everything go" is answered by the screen instead of by reading
// five files. It is IMPORTED from the kernel, never transcribed.
//
// ⚠️ The layout table is a pure table with no imports, so rendering it here costs the client nothing
// and cannot drift (`SystemAccounting.BLOCKS` was a hand-kept copy and it had already gone stale).

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

  const slotLabel = (name: string) => language.t(`settings.contextLayout.slot.${name}` as never) || name

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.contextLayout.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.contextLayout.description.more")}</p>
      </div>

      <div class="settings-v2-tab-body">
        {/*
          🔴 THE LAYOUT (owner, 2026-09-16: *"clearly exposing the layout in UI, while allowing user to
          both view and edit it"*). It is the kernel's own table, in order, with the two facts a reader
          cannot get from anywhere else today: WHERE each part comes from, and HOW LONG it survives.
        */}
        <div class="settings-v2-section" data-component="settings-context-layout">
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
