import { For, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useAppTheme, APP_THEME_PRESETS } from "@/context/app-theme"

// The color-scheme picker (uix.md §7.5): a radiogroup of swatch cards painted with each preset's own
// bg + accent, an accent ring on the selected one, and a LIVE preview on hover (apply on enter, restore
// the committed value on leave) — mirroring the color-scheme select's preview pattern.
export const ThemeSwatches: Component = () => {
  const language = useLanguage()
  const appTheme = useAppTheme()
  const tk = (key: string) => language.t(key as Parameters<typeof language.t>[0])

  return (
    <div class="flex flex-wrap gap-2.5" role="radiogroup" aria-label={language.t("settings.appearance.theme.title")}>
      <For each={APP_THEME_PRESETS}>
        {(preset) => (
          <button
            type="button"
            role="radio"
            aria-checked={appTheme.current() === preset.id}
            aria-label={tk(preset.nameKey)}
            data-action={`settings-app-theme-${preset.id}`}
            class="group flex flex-col items-center gap-1.5 rounded-xl p-1.5 ring-1 transition-all focus:outline-none focus-visible:ring-2"
            classList={{
              "ring-v2-border-border-focus": appTheme.current() === preset.id,
              "ring-v2-border-border-base hover:ring-v2-border-border-strong": appTheme.current() !== preset.id,
            }}
            onClick={() => appTheme.set(preset.id)}
            onMouseEnter={() => appTheme.preview(preset.id)}
            onMouseLeave={() => appTheme.cancelPreview()}
          >
            <div class="relative h-12 w-[4.5rem] overflow-hidden rounded-lg ring-1 ring-white/10" style={{ background: preset.bg }}>
              <div class="absolute bottom-1.5 left-1.5 size-4 rounded-full shadow-sm" style={{ background: preset.accent }} />
            </div>
            <span class="text-[11px] font-medium text-v2-text-text-muted">{tk(preset.nameKey)}</span>
          </button>
        )}
      </For>
    </div>
  )
}
