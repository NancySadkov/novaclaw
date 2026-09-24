import { Component, Show, createSignal } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
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
import { SettingsTrashV2 } from "./trash"
import { SettingsServersV2 } from "./servers"
import { SettingsComputerV2 } from "./computer"
import { SettingsRecoveryV2 } from "./recovery"
import { SettingsWebSearchV2 } from "./web-search"

const TAB_LEVELS: Record<string, ExpertiseLevel> = {
  computer: "advanced",
  "web-search": "advanced",
}
const SETTINGS_TABS = new Set(["general", "appearance", "shortcuts", "servers", "computer", "web-search", "usage", "storage", "trash", "recovery", "about"])

export const SettingsScreen: Component<{
  defaultTab?: string
  onDismiss: () => void
}> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const desktop = createMediaQuery("(min-width: 768px)")
  const { atLeast } = useExpertise()
  const tabVisible = (tab: string) => {
    if (!SETTINGS_TABS.has(tab)) return false
    const level = TAB_LEVELS[tab]
    return !level || atLeast(level)
  }
  const requested = props.defaultTab ?? "general"
  const initialTab = tabVisible(requested) ? requested : "general"
  const [tab, setTab] = createSignal(initialTab)

  return (
    <div class="settings-v2-screen">
      <button type="button" class="settings-v2-close" aria-label={language.t("common.close")} onClick={props.onDismiss}>
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
      </button>
      <Show when={server.key} keyed>
        <ServerSDKProvider>
          <ServerSyncProvider>
            <TabsV2
              orientation={desktop() ? "vertical" : "horizontal"}
              variant="settings"
              value={tab()}
              onChange={setTab}
              class="settings-v2"
            >
              <TabsV2.List>
                <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                <TabsV2.Trigger value="general">
                  <Icon name="sliders" size="large" />
                  {language.t("settings.tab.general")}
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
                <Show when={tabVisible("computer")}>
                  <TabsV2.Trigger value="computer">
                    <Icon name="window-cursor" size="large" />
                    {language.t("settings.computer.title")}
                  </TabsV2.Trigger>
                </Show>
                <Show when={tabVisible("web-search")}>
                  <TabsV2.Trigger value="web-search">
                    <Icon name="magnifying-glass" size="large" />
                    {language.t("settings.webSearch.title")}
                  </TabsV2.Trigger>
                </Show>
                <TabsV2.SectionTitle>{language.t("settings.section.safety")}</TabsV2.SectionTitle>
                <TabsV2.Trigger value="usage">
                  <Icon name="bullet-list" size="large" />
                  {language.t("settings.usage.title")}
                </TabsV2.Trigger>
                <TabsV2.Trigger value="storage">
                  <Icon name="folder" size="large" />
                  {language.t("settings.tab.storage")}
                </TabsV2.Trigger>
                <TabsV2.Trigger value="trash">
                  <Icon name="trash" size="large" />
                  {language.t("trash.title")}
                </TabsV2.Trigger>
                <TabsV2.Trigger value="recovery">
                  <Icon name="reset" size="large" />
                  {language.t("settings.tab.recovery")}
                </TabsV2.Trigger>
                <TabsV2.Trigger value="about">
                  <Icon name="info" size="large" />
                  {language.t("settings.tab.about")}
                </TabsV2.Trigger>
              </TabsV2.List>
              <TabsV2.Content value="general" class="settings-v2-panel">
                {/* `setTab` is handed down so General's health pointer can open the report. The
                    health report moved to Health & recovery (see general.tsx's header block); this
                    one click is part of what keeps a worried user's path as short as it was. */}
                <SettingsGeneralV2 onOpenTab={setTab} />
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
              <Show when={tabVisible("web-search")}>
                <TabsV2.Content value="web-search" class="settings-v2-panel">
                  <SettingsWebSearchV2 />
                </TabsV2.Content>
              </Show>
              <TabsV2.Content value="usage" class="settings-v2-panel">
                <SettingsUsageV2 />
              </TabsV2.Content>
              <TabsV2.Content value="storage" class="settings-v2-panel">
                <SettingsStorageV2 />
              </TabsV2.Content>
              <TabsV2.Content value="trash" class="settings-v2-panel">
                <SettingsTrashV2 />
              </TabsV2.Content>
              <TabsV2.Content value="recovery" class="settings-v2-panel">
                <SettingsRecoveryV2 />
              </TabsV2.Content>
              <TabsV2.Content value="about" class="settings-v2-panel">
                <Show when={tab() === "about"}>
                  <SettingsAboutV2 />
                </Show>
              </TabsV2.Content>
            </TabsV2>
          </ServerSyncProvider>
        </ServerSDKProvider>
      </Show>
    </div>
  )
}
