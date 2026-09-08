import { Component, Show, createSignal } from "solid-js"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { TabsV2 } from "@novaclaw/ui/v2/tabs-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { useExpertise } from "@/context/expertise"
import type { ExpertiseLevel } from "@/context/settings"
import { SettingsGeneralV2 } from "./general"
import { SettingsAboutV2 } from "./about"
import { SettingsStorageV2 } from "./storage"
import { SettingsUsageV2 } from "./usage"
import { SettingsAppearanceV2 } from "./appearance"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsModelsV2 } from "./models"
import { SettingsServersV2 } from "./servers"
import { SettingsIntrospectionV2 } from "./introspection"
import { SettingsSystemPromptV2 } from "./system-prompt"
import { SettingsAffectiveV2 } from "./affective"
import { SettingsStrictV2 } from "./strict"
import { SettingsComputerV2 } from "./computer"
import { SettingsToolsV2 } from "./tools"
import { SettingsQualityV2 } from "./quality"
import { SettingsRecoveryV2 } from "./recovery"
import { SettingsMessengersV2 } from "./messengers"
import { SettingsWebSearchV2 } from "./web-search"
import { SettingsTunesV2 } from "./tunes"
import { SettingsNudgesV2 } from "./nudges"

// Tabs above Normal are hidden until unlocked (uix.md §6.4). Bootstrap/manage/reset stay universal:
// General, Memory, Appearance, Shortcuts, Instances, Models, Storage and Recovery carry no entry (= Normal).
const TAB_LEVELS: Record<string, ExpertiseLevel> = {
  "system-prompt": "advanced",
  tunes: "advanced",
  nudges: "advanced",
  computer: "advanced",
  tools: "advanced",
  strict: "advanced",
  // Web search "just works" for a normal user via the built-in; the override (own SearXNG) +
  // per-engine toggles are a power-user surface → Advanced (and therefore Developer too).
  "web-search": "advanced",
  introspection: "developer",
  affective: "developer",
  quality: "developer",
}

export const DialogSettings: Component<{
  sessionID?: string
  defaultTab?: string
}> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const { atLeast } = useExpertise()
  const tabVisible = (tab: string) => {
    const level = TAB_LEVELS[tab]
    return !level || atLeast(level)
  }
  // Never open on a tab the current level can't see (a deep-link into a now-hidden tab falls
  // back to General rather than selecting a phantom Kobalte value).
  const requested = props.defaultTab ?? "general"
  const initialTab = tabVisible(requested) ? requested : "general"
  // Controlled selection held OUTSIDE the keyed server boundary below, so an instance switch
  // re-keys the panels without losing which tab the user is on.
  const [tab, setTab] = createSignal(initialTab)

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      {/* Every dialog needs a visible ✕ — the settings variant skips DialogHeader (the tab rail
          owns the layout), so it mounts its own corner close button (uix: never trap a lay user). */}
      <KobalteDialog.CloseButton class="settings-v2-close" aria-label={language.t("common.close")}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M12.4446 3.55469L3.55566 12.4436M3.55566 3.55469L12.4446 12.4436"
            stroke="currentColor"
            stroke-linejoin="round"
          />
        </svg>
      </KobalteDialog.CloseButton>
      {/* R8 residue fix: dialogs mount in a MANUAL root under an owner captured at show() time —
          when the app's keyed ServerKey boundary disposes on an instance switch, an open dialog
          survives but keeps reading the DISPOSED (frozen) server-sync ctx, so config-backed
          controls showed the PREVIOUS instance's values (and an airgapped instance's reboot read
          a stale offline=false). The dialog therefore mounts its OWN keyed server providers: the
          live useServer().key re-keys the panels to the active instance's fresh ctx. */}
      <Show when={server.key} keyed>
        <ServerSDKProvider>
          <ServerSyncProvider>
            <TabsV2 orientation="vertical" variant="settings" value={tab()} onChange={setTab} class="settings-v2">
              <TabsV2.List>
                <div class="flex flex-col justify-between h-full w-full">
                  <div class="flex flex-col gap-3 w-full">
                    <div class="flex flex-col gap-3">
                      <div class="flex flex-col gap-1.5">
                        <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                        <div class="flex flex-col gap-1.5 w-full">
                          <TabsV2.Trigger value="general">
                            <Icon name="sliders" size="large" />
                            {language.t("settings.tab.general")}
                          </TabsV2.Trigger>
                          {/* 🔴 The Memory tab is RETIRED (owner, 2026-08-20: *"we still have Memory
                        tab in the settings, instead of everything migrated to the app"*). Everything it
                        held — consent, the embedding and judge rows, export/import, document ingest,
                        the Remembered list — now lives in the Memory APP as its third view, rendered
                        from the same component. Settings keeps what is instance CONFIGURATION; what
                        Nova knows about you is a thing you go and look at, not a preference. */}
                          {/* Models sits right under General — adding/configuring/importing models is the
                        high-value task while local hardware can't run the best model out of the box. */}
                          <TabsV2.Trigger value="models">
                            <Icon name="cpu" size="large" />
                            {language.t("settings.models.title")}
                          </TabsV2.Trigger>
                          <TabsV2.Trigger value="appearance">
                            <Icon name="palette" size="large" />
                            {language.t("settings.tab.appearance")}
                          </TabsV2.Trigger>
                          <TabsV2.Trigger value="shortcuts">
                            <Icon name="keyboard" size="large" />
                            {language.t("settings.tab.shortcuts")}
                          </TabsV2.Trigger>
                          <TabsV2.Trigger value="servers">
                            <Icon name="share" size="large" />
                            {language.t("settings.tab.instances")}
                          </TabsV2.Trigger>
                          {/* Messengers — a headline lay feature (messenger-plan §6.1): connect Telegram
                        & friends so the agent covers chats while you're away. Normal level. */}
                          <TabsV2.Trigger value="messengers">
                            <Icon name="speech-bubble" size="large" />
                            {language.t("settings.messengers.title")}
                          </TabsV2.Trigger>
                          <Show when={tabVisible("system-prompt")}>
                            <TabsV2.Trigger value="system-prompt">
                              <Icon name="prompt" size="large" />
                              {language.t("settings.systemPrompt.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("tunes")}>
                            <TabsV2.Trigger value="tunes">
                              <Icon name="sliders" size="large" />
                              {language.t("settings.tunes.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("nudges")}>
                            <TabsV2.Trigger value="nudges">
                              <Icon name="prompt" size="large" />
                              {language.t("settings.nudges.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("introspection")}>
                            <TabsV2.Trigger value="introspection">
                              <Icon name="eye" size="large" />
                              {language.t("settings.introspection.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("affective")}>
                            <TabsV2.Trigger value="affective">
                              <Icon name="brain" size="large" />
                              {language.t("settings.affective.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("strict")}>
                            <TabsV2.Trigger value="strict">
                              <Icon name="shield" size="large" />
                              {language.t("settings.strict.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("computer")}>
                            <TabsV2.Trigger value="computer">
                              <Icon name="window-cursor" size="large" />
                              {language.t("settings.computer.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("tools")}>
                            <TabsV2.Trigger value="tools">
                              <Icon name="code-lines" size="large" />
                              {language.t("settings.tools.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("web-search")}>
                            <TabsV2.Trigger value="web-search">
                              <Icon name="magnifying-glass" size="large" />
                              {language.t("settings.webSearch.title")}
                            </TabsV2.Trigger>
                          </Show>
                          <Show when={tabVisible("quality")}>
                            <TabsV2.Trigger value="quality">
                              <Icon name="checklist" size="large" />
                              {language.t("settings.quality.title")}
                            </TabsV2.Trigger>
                          </Show>
                        </div>
                      </div>

                      <div class="flex flex-col gap-1.5">
                        <TabsV2.SectionTitle>{language.t("settings.section.safety")}</TabsV2.SectionTitle>
                        <div class="flex flex-col gap-1.5 w-full">
                          <TabsV2.Trigger value="usage">
                            <Icon name="bullet-list" size="large" />
                            {language.t("settings.usage.title")}
                          </TabsV2.Trigger>
                          <TabsV2.Trigger value="storage">
                            <Icon name="folder" size="large" />
                            {language.t("settings.tab.storage")}
                          </TabsV2.Trigger>
                          <TabsV2.Trigger value="recovery">
                            <Icon name="reset" size="large" />
                            {language.t("settings.tab.recovery")}
                          </TabsV2.Trigger>
                          <TabsV2.Trigger value="about">
                            <Icon name="info" size="large" />
                            {language.t("settings.tab.about")}
                          </TabsV2.Trigger>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </TabsV2.List>
              <TabsV2.Content value="general" class="settings-v2-panel">
                {/* `setTab` is handed down so General's health pointer can open the report. The
                    health report moved to Health & recovery (see general.tsx's header block); this
                    one click is part of what keeps a worried user's path as short as it was. */}
                <SettingsGeneralV2 sessionID={props.sessionID} onOpenTab={setTab} />
              </TabsV2.Content>
              <TabsV2.Content value="appearance" class="settings-v2-panel">
                <SettingsAppearanceV2 />
              </TabsV2.Content>
              <TabsV2.Content value="shortcuts" class="settings-v2-panel">
                <SettingsKeybinds />
              </TabsV2.Content>
              <TabsV2.Content value="servers" class="settings-v2-panel">
                <SettingsServersV2 />
              </TabsV2.Content>
              <TabsV2.Content value="messengers" class="settings-v2-panel">
                <SettingsMessengersV2 />
              </TabsV2.Content>
              <TabsV2.Content value="models" class="settings-v2-panel">
                <SettingsModelsV2 />
              </TabsV2.Content>
              <Show when={tabVisible("system-prompt")}>
                <TabsV2.Content value="system-prompt" class="settings-v2-panel">
                  <SettingsSystemPromptV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("tunes")}>
                <TabsV2.Content value="tunes" class="settings-v2-panel">
                  <SettingsTunesV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("nudges")}>
                <TabsV2.Content value="nudges" class="settings-v2-panel">
                  <SettingsNudgesV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("introspection")}>
                <TabsV2.Content value="introspection" class="settings-v2-panel">
                  <SettingsIntrospectionV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("affective")}>
                <TabsV2.Content value="affective" class="settings-v2-panel">
                  <SettingsAffectiveV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("strict")}>
                <TabsV2.Content value="strict" class="settings-v2-panel">
                  <SettingsStrictV2 />
                </TabsV2.Content>
              </Show>
              {/* ⚠️ This panel used to sit INSIDE `TabsV2.List`, between the "computer" and "tools"
                  triggers — so the whole Computer Use tab rendered squeezed into the left tab rail
                  instead of the content area, while every sibling panel lived out here. Kobalte
                  places `Content` wherever it is written; nothing warns you. Keep panels in this
                  block, in trigger order. */}
              <Show when={tabVisible("computer")}>
                <TabsV2.Content value="computer" class="settings-v2-panel">
                  <SettingsComputerV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("tools")}>
                <TabsV2.Content value="tools" class="settings-v2-panel">
                  <SettingsToolsV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("web-search")}>
                <TabsV2.Content value="web-search" class="settings-v2-panel">
                  <SettingsWebSearchV2 />
                </TabsV2.Content>
              </Show>
              <Show when={tabVisible("quality")}>
                <TabsV2.Content value="quality" class="settings-v2-panel">
                  <SettingsQualityV2 />
                </TabsV2.Content>
              </Show>
              <TabsV2.Content value="usage" class="settings-v2-panel">
                <SettingsUsageV2 />
              </TabsV2.Content>
              <TabsV2.Content value="storage" class="settings-v2-panel">
                <SettingsStorageV2 />
              </TabsV2.Content>
              <TabsV2.Content value="recovery" class="settings-v2-panel">
                <SettingsRecoveryV2 />
              </TabsV2.Content>
              <TabsV2.Content value="about" class="settings-v2-panel">
                <SettingsAboutV2 />
              </TabsV2.Content>
            </TabsV2>
          </ServerSyncProvider>
        </ServerSDKProvider>
      </Show>
    </Dialog>
  )
}
