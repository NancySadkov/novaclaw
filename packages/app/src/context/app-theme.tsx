import { createEffect, type Component } from "solid-js"
import { useSettings } from "@/context/settings"

// Color-scheme presets (uix.md §7). Nova is the default and is defined inline in index.css with NO
// data-app-theme attribute, so any failure degrades to today's look. summer/autumn are additive
// override blocks (themes/*.css). Adding a preset = a CSS file + one row here.
export type AppThemeId = "nova" | "summer" | "autumn"

export const APP_THEME_PRESETS: { id: AppThemeId; nameKey: string; accent: string; bg: string }[] = [
  { id: "nova", nameKey: "settings.appearance.theme.nova", accent: "#e7b62f", bg: "#201748" },
  { id: "summer", nameKey: "settings.appearance.theme.summer", accent: "#ff7a59", bg: "#0e2e2b" },
  { id: "autumn", nameKey: "settings.appearance.theme.autumn", accent: "#e8933a", bg: "#2a1519" },
]

const RAW_KEY = "novaclaw-app-theme"

// Apply a preset: setting body[data-app-theme] ("nova" REMOVES it → the default Nova block wins). Also
// mirrors to raw localStorage so oc-theme-preload.js could theme the first frame (no FOUC) later.
export function applyAppTheme(id: string): void {
  if (typeof document === "undefined") return
  if (id && id !== "nova") document.body.dataset.appTheme = id
  else delete document.body.dataset.appTheme
  try {
    if (id && id !== "nova") localStorage.setItem(RAW_KEY, id)
    else localStorage.removeItem(RAW_KEY)
  } catch {
    // localStorage unavailable — the attribute above still applies for this session.
  }
}

// Mount once (beside BodyDesignClass): keep body[data-app-theme] in sync with the persisted setting.
export const AppThemeEffect: Component = () => {
  const settings = useSettings()
  createEffect(() => applyAppTheme(settings.appearance.appTheme()))
  return null
}

// Picker helpers: preview on hover (apply directly), cancel restores the committed value.
export function useAppTheme() {
  const settings = useSettings()
  return {
    current: () => settings.appearance.appTheme(),
    set: (id: AppThemeId) => settings.appearance.setAppTheme(id),
    preview: (id: string) => applyAppTheme(id),
    cancelPreview: () => applyAppTheme(settings.appearance.appTheme()),
  }
}
