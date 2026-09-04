import { Component, createSignal, onCleanup } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { removePersisted } from "@/utils/persist"
import { HELP_SEEN_KEY } from "@/pages/home-screen/help-tour"
import { NovaHealthBoard } from "./nova-health"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"
import { resumeInterruptedOn, resumeInterruptedPatch } from "./recovery-state"
import { useSettingsConfigWrite } from "./parts/config-write"

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

// The Health & recovery tab — the tab a person opens when something is WRONG.
//
// 🔴 It gained the health report on 2026-08-19, and the reasoning belongs here as much as in
// `nova-health.tsx`. `uix.md` §7 has always given this section the pillar *understand + reset*, and
// until now it only did the second half: it offered three ways to undo without ever saying what was
// broken. The report is the "understand" half, and it had been sitting in General — the tab you open
// to CHANGE something — alongside a second read-only board (Confinement, now folded into the report
// itself). The rule, stated so the next status board has an obvious home: **General is what you SET;
// a read-only reading of this instance is a finding, and findings go in the health report, which
// lives here.**
//
// ⚠️ THE REPORT LEADS THIS TAB, and that ordering is load-bearing rather than cosmetic. The argument
// for it leading General was that a worried user must not read a language picker first; the same
// argument says they must not read a *reset* button first either. Diagnose, then undo — in that
// order, because two of the three rungs below are irreversible and a person should know what is
// actually wrong before reaching for them.
//
// Then the three rungs of "get me back to a good state", weakest to strongest:
//   1. Reset UI preferences — live today (see the curated list above; chats/servers/drafts untouched).
//   2. Snapshots — restore-to-a-date (pairs with the dated Trash). Server-side; surfaced as coming soon.
//   3. Factory reset — erase chats/sessions/config on this device. Server-side; surfaced as coming soon.
// The coming-soon rows are shown (disabled) rather than hidden: the surface documents the safety model
// so users know deletions are recoverable BEFORE they need it.
export const SettingsRecoveryV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSync = useServerSync()
  const writeConfig = useSettingsConfigWrite()

  // Read/patch logic lives in `recovery-state.ts` so it can be ratcheted against the kernel's own
  // default — see that file and its test.
  const config = () => serverSync().data.config
  const resumeOn = () => resumeInterruptedOn(config())

  async function setResume(value: boolean) {
    await writeConfig(resumeInterruptedPatch(config(), value))
  }

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
        <NovaHealthBoard />

        {/*
          ⚠️ BEHAVIOUR before the undo ladder, which follows this tab's own stated order: diagnose,
          then recover. This switch decides what Nova does WITHOUT being asked, so it belongs above
          three buttons a worried person might otherwise reach for first.
        */}
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.recovery.section.afterCrash")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.recovery.row.resumeInterrupted.title")}
              description={
                <>
                  {language.t("settings.recovery.row.resumeInterrupted.description")}
                  <SettingsExplainV2 label={language.t("settings.recovery.row.resumeInterrupted.title")}>
                    {language.t("settings.recovery.row.resumeInterrupted.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <Switch
                checked={resumeOn()}
                onChange={(value) => void setResume(value)}
                data-action="settings-recovery-resume-interrupted"
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.recovery.section.restore")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.recovery.row.resetUi.title")}
              description={
                <>
                  {language.t("settings.recovery.row.resetUi.description")}
                  <SettingsExplainV2 label={language.t("settings.recovery.row.resetUi.title")}>
                    {language.t("settings.recovery.row.resetUi.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <ButtonV2
                size="normal"
                variant={armed() ? "danger" : "neutral"}
                onClick={resetUi}
                data-action="settings-recovery-reset-ui"
              >
                {armed()
                  ? language.t("settings.recovery.row.resetUi.confirm")
                  : language.t("settings.recovery.row.resetUi.action")}
              </ButtonV2>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.recovery.row.snapshots.title")}
              description={
                <>
                  {language.t("settings.recovery.row.snapshots.description")}
                  <SettingsExplainV2 label={language.t("settings.recovery.row.snapshots.title")}>
                    {language.t("settings.recovery.row.snapshots.description.more")}
                  </SettingsExplainV2>
                </>
              }
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
