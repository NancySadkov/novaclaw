import { Component, createMemo, createResource, onMount, Show } from "solid-js"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useTheme, type ColorScheme } from "@novaclaw/ui/theme/context"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "../link"
import { ThemeSwatches } from "./parts/theme-swatches"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

// The Appearance tab — the look/feel of the app (color scheme, theme, fonts) plus Sound Effects,
// lifted out of General so the app-wide config there isn't cluttered with per-device presentation.
type ThemeOption = { id: string; name: string }

// Debounce sound demos so quick selection changes don't overlap (moved with Sound Effects).
let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) demoSoundState.cleanup()
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}
const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return
  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsAppearanceV2: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const settings = useSettings()
  const platform = usePlatform()

  // 🔴 RESTORED 2026-08-07. Pinch-to-zoom is the one of the seven orphaned settings that still
  // drives real behaviour: `packages/desktop`'s main process persists it under the electron-store
  // key `pinchZoomEnabled` (`main/store-keys.ts`), `main/windows.ts` reads it per BrowserWindow to
  // gate `webContents.setVisualZoomLevelLimits`, and `renderer/webview-zoom.ts` gates the
  // wheel/gesture handler on it. It defaults to OFF (`getStore().get(...) === true`), and its only
  // writer went with the unreachable v1 settings panel — so a trackpad user had no way to turn
  // their zoom gesture back on. The other six drove nothing and were deleted instead.
  //
  // Desktop-only by CAPABILITY, not by `platform.platform`: the whole chain is Electron IPC, and on
  // the web the accessors are simply absent, so a missing accessor is the honest gate.
  const pinchZoomSupported = createMemo(() => Boolean(platform.getPinchZoomEnabled && platform.setPinchZoomEnabled))
  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    pinchZoomSupported,
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )
  // Optimistic, and it ROLLS BACK on rejection — the switch must never claim a state the main
  // process refused, because nothing else on this screen would contradict it.
  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void Promise.resolve(update).catch(() => setPinchZoom(!checked))
  }

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))
  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
  })

  onMount(() => {
    void theme.loadThemes()
  })

  const AppearanceSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.appearance.section.visual")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.appearance.theme.title")}
          description={language.t("settings.appearance.theme.description")}
        >
          <ThemeSwatches />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            onHighlight={(option) => {
              if (!option) return
              theme.previewColorScheme(option.value)
              return () => theme.cancelPreview()
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <Link class="settings-v2-link" href="https://novaclaw.app/docs/themes/">
                {language.t("common.learnMore")}
              </Link>
            </>
          }
        >
          <SelectV2
            appearance="inline"
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            onHighlight={(option) => {
              if (!option) return
              theme.previewTheme(option.id)
              return () => theme.cancelPreview()
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.uiFont.title")}
          description={language.t("settings.general.row.uiFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-ui-font"
              type="text"
              appearance="base"
              value={sans()}
              onInput={(event) => settings.appearance.setUIFont(event.currentTarget.value)}
              placeholder={sansDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.uiFont.title")}
              style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-code-font"
              type="text"
              appearance="base"
              value={mono()}
              onInput={(event) => settings.appearance.setFont(event.currentTarget.value)}
              placeholder={monoDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.font.title")}
              style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
            />
          </div>
        </SettingsRowV2>

        <Show when={pinchZoomSupported()}>
          <SettingsRowV2
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch
                checked={pinchZoom.latest}
                onChange={onPinchZoomChange}
                aria-label={language.t("settings.general.row.pinchZoom.title")}
              />
            </div>
          </SettingsRowV2>
        </Show>

        <SettingsRowV2
          title={language.t("settings.general.row.terminalFont.title")}
          description={language.t("settings.general.row.terminalFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-terminal-font"
              type="text"
              appearance="base"
              value={terminal()}
              onInput={(event) => settings.appearance.setTerminalFont(event.currentTarget.value)}
              placeholder={terminalDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.terminalFont.title")}
              style={{ "font-family": terminalFontFamily(settings.appearance.terminalFont()) }}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const SoundsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.appearance")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <AppearanceSection />
        <SoundsSection />
      </div>
    </>
  )
}
