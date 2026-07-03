import { Component, createSignal, onCleanup } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { removePersisted } from "@/utils/persist"
import { HELP_SEEN_KEY } from "@/pages/home-screen/help-tour"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// The UI-preference surface, and ONLY that. localStorage is the app's whole persistence backend on
// web (servers, drafts, prompt history all live there — see utils/persist.ts), so a blanket
// localStorage.clear() would be a partial factory reset, not a preference reset; and on desktop the
// real stores are file-backed behind platform.storage, which localStorage.clear() can't touch at all.
// Curate instead: the "settings.v3" store (view options, layout, fonts, notifications, sounds) via
// removePersisted (routes correctly on BOTH platforms), plus the raw-localStorage theme keys
// (@novaclaw/ui theme/context STORAGE_KEYS) and the first-run tour flag.
const UI_PREF_TARGETS = [{ key: "settings.v3" }]
const UI_PREF_RAW_KEYS = [
  HELP_SEEN_KEY,
  "novaclaw.home.order", // home-screen ORDER_KEY — drag-reorder arrangement is a UI pref, so reset it too (L6)
  "novaclaw-app-theme", // color-scheme preset mirror (uix.md §7)
  "novaclaw-theme-id",
  "novaclaw-color-scheme",
  "novaclaw-theme-css-light",
  "novaclaw-theme-css-dark",
]

// The Recovery tab — the vision's third settings pillar (bootstrap · manage · RESET). Three rungs of
// "get me back to a good state", weakest to strongest:
//   1. Reset UI preferences — live today (see the curated list above; chats/servers/drafts untouched).
//   2. Snapshots — restore-to-a-date (pairs with the dated Trash). Server-side; surfaced as coming soon.
//   3. Factory reset — erase chats/sessions/config on this device. Server-side; surfaced as coming soon.
// The coming-soon rows are shown (disabled) rather than hidden: the surface documents the safety model
// so users know deletions are recoverable BEFORE they need it.
export const SettingsRecoveryV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  // Two-step confirm for the destructive-ish action: first click arms, second click fires.
  const [armed, setArmed] = createSignal(false)
  let disarm: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(disarm))

  const resetUi = () => {
    if (!armed()) {
      setArmed(true)
      clearTimeout(disarm)
      disarm = setTimeout(() => setArmed(false), 4000)
      return
    }
    for (const target of UI_PREF_TARGETS) removePersisted(target, platform)
    try {
      for (const key of UI_PREF_RAW_KEYS) localStorage.removeItem(key)
    } catch {
      // localStorage unavailable — the persisted-store removal above still applies.
    }
    location.reload()
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.recovery")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.recovery.row.resetUi.title")}
              description={language.t("settings.recovery.row.resetUi.description")}
            >
              <ButtonV2 size="normal" variant={armed() ? "danger" : "neutral"} onClick={resetUi} data-action="settings-recovery-reset-ui">
                {armed() ? language.t("settings.recovery.row.resetUi.confirm") : language.t("settings.recovery.row.resetUi.action")}
              </ButtonV2>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.recovery.row.snapshots.title")}
              description={language.t("settings.recovery.row.snapshots.description")}
            >
              <ButtonV2 size="normal" variant="neutral" disabled data-action="settings-recovery-snapshots">
                {language.t("settings.recovery.row.snapshots.action")}
              </ButtonV2>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.recovery.row.factory.title")}
              description={language.t("settings.recovery.row.factory.description")}
            >
              <ButtonV2 size="normal" variant="neutral" disabled data-action="settings-recovery-factory-reset">
                {language.t("settings.recovery.row.factory.action")}
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
