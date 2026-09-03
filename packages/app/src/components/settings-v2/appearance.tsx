import { Component, createMemo, createResource, onCleanup, onMount, Show, createSignal } from "solid-js"
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
import { BUNDLED_MONO, BUNDLED_SANS, CANDIDATE_MONO, CANDIDATE_SANS, makeFontProbe, offeredFonts } from "./fonts"

// The Appearance tab — the look/feel of the app (color scheme, theme, fonts) plus Sound Effects,
// lifted out of General so the app-wide config there isn't cluttered with per-device presentation.
type ThemeOption = { id: string; name: string }

/**
 * The sound demo, debounced so quick selection changes don't overlap — and **owned by the panel that
 * schedules it.**
 *
 * 🔴 This state used to be a module-level `let`, which is the class: *a timer whose handle lives
 * outside any component's lifecycle, so nothing is in a position to cancel it when its owner goes
 * away.* Hovering a sound option armed a 100 ms `setTimeout`; closing Settings inside that window
 * played the sound into a panel that no longer existed, and left its stop-handle in a global nobody
 * would ever call again. `SelectV2` could not save it either — its `onCleanup(stop)` invokes only the
 * closure RETURNED by `onHighlight`, and the three sound rows returned `undefined` while the colour
 * scheme and theme rows beside them correctly returned `theme.cancelPreview`.
 *
 * Creating it under the component's owner is what makes the cancel structural: `onCleanup` is
 * registered by the factory, so there is no way to schedule a demo that outlives the panel — and it
 * covers the `onSelect` path too, which `onHighlight`'s return value never could.
 *
 * ⚠️ Exported only so a test can own it: driving the three sound rows from the DOM would mean opening
 * a Kobalte dropdown, which a synthetic click does not do (`computer.test.ts` states the same limit).
 * The panel's use of it is pinned by the ledger in `numeric-and-timer-ledger.test.ts`.
 */
export const createDemoSound = () => {
  let cleanup: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let run = 0
  const stop = () => {
    run += 1
    if (cleanup) cleanup()
    cleanup = undefined
    clearTimeout(timeout)
    timeout = undefined
  }
  const play = (id: string | undefined) => {
    stop()
    if (!id) return
    const started = ++run
    timeout = setTimeout(() => {
      void playSoundById(id).then((stopPlayback) => {
        if (run !== started) {
          stopPlayback?.()
          return
        }
        cleanup = stopPlayback
      })
    }, 100)
  }
  onCleanup(stop)
  return { play, stop }
}

const FONT_CUSTOM = "type-a-font-name"
/** Unset means "use the default", which every font row's copy promises. A blank trigger states
 *  nothing, so the default is a NAMED option whose selection persists "" — the stored form of unset. */
const FONT_DEFAULT = "use-the-default"

/**
 * One control for all three font rows (UI · code · terminal). They differ only in their candidate
 * list, their accessor pair and their preview family; the six rules do not, so they live here once:
 * shipped fonts are offered unprobed, a value already set is always offered, unset shows the named
 * default, and free text stays reachable and labelled.
 */
const FontPicker: Component<{
  value: string
  onChange: (value: string) => void
  bundled: readonly string[]
  candidates: readonly string[]
  fallbackDefault: string
  previewFamily: string
  label: string
  action: string
  probe: (family: string) => boolean
}> = (props) => {
  const language = useLanguage()
  const [typing, setTyping] = createSignal(false)
  const choices = createMemo(() =>
    offeredFonts({
      bundled: props.bundled,
      candidates: props.candidates,
      present: props.probe,
      current: props.value,
    }),
  )
  const defaultOption = () => ({
    value: FONT_DEFAULT,
    label: `${language.t("settings.general.row.font.default")} (${props.fallbackDefault})`,
  })
  return (
    <div class="w-full sm:w-[220px]">
      <Show
        when={!typing()}
        fallback={
          <TextInputV2
            data-action={props.action}
            type="text"
            appearance="base"
            value={props.value}
            onInput={(event) => props.onChange(event.currentTarget.value)}
            placeholder={props.fallbackDefault}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={props.label}
            style={{ "font-family": props.previewFamily }}
          />
        }
      >
        <SelectV2
          appearance="inline"
          data-action={props.action}
          options={[
            defaultOption(),
            ...choices().map((family) => ({ value: family, label: family })),
            { value: FONT_CUSTOM, label: language.t("settings.general.row.font.custom") },
          ]}
          current={props.value ? { value: props.value, label: props.value } : defaultOption()}
          placement="bottom-end"
          gutter={6}
          value={(option) => option.value}
          label={(option) => option.label}
          onSelect={(option) => {
            if (!option) return
            if (option.value === FONT_CUSTOM) return setTyping(true)
            props.onChange(option.value === FONT_DEFAULT ? "" : option.value)
          }}
        />
      </Show>
    </div>
  )
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

  // Probed ONCE per dialog: each check renders a probe string twice per generic fallback, and
  // re-running it per render would measure text on every keystroke in here.
  const fontProbe = makeFontProbe()
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const demoSound = createDemoSound()
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
      demoSound.play(option.id === "none" ? undefined : option.id)
      // ⚠️ **Deliberately returns nothing**, unlike the colour-scheme and theme rows above. The
      // obvious-looking fix here — return `demoSound.stop` so `SelectV2` cancels it — cancels the
      // WRONG demo: `SelectV2`'s `onChange` runs `onSelect` (which plays the picked sound) and then
      // `stop()`, so the returned cleanup would kill the 100 ms timer the pick had just armed. The
      // theme rows are unharmed by that order because their cleanup only ends a PREVIEW of a value
      // `onSelect` has already committed. Cancellation for this row is the panel-scoped
      // `onCleanup` inside `createDemoSound`, which covers the select path too.
    },
    onSelect: (option: (typeof soundOptions)[number] | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        demoSound.stop()
        return
      }
      setEnabled(true)
      set(option.id)
      demoSound.play(option.id)
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
          {/* Disabled with a reason, not hidden (ruling 13's adversary reversal, uix.md §7's
              coming-soon precedent): `index.css` hard-sets `color-scheme: dark` and remaps 62 of
              the 82 `--v2-*` tokens unlayered, so picking Light repaints twenty avatar chips and
              nothing else. Until a light preset exists the control shows the mode that IS in
              force (principle 12d) and the copy beside it says why. Re-enable by deleting
              `disabled` and restoring `current` to the stored scheme, in the same change that
              lands the preset. */}
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            disabled
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === "dark")}
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

        {/* Ruling 13: the 37-item inherited theme list is not a lay control — ThemeSwatches above is the
            one palette control a lay user sees, and the engine stays a store. The picker leaves the lay
            tab by gating, not deletion (2026-09-03). */}
        <SettingsRowV2
          minLevel="developer"
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
          <FontPicker
            value={sans()}
            onChange={(value) => settings.appearance.setUIFont(value)}
            bundled={BUNDLED_SANS}
            candidates={CANDIDATE_SANS}
            fallbackDefault={sansDefault}
            previewFamily={sansFontFamily(settings.appearance.uiFont())}
            label={language.t("settings.general.row.uiFont.title")}
            action="settings-ui-font"
            probe={fontProbe}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <FontPicker
            value={mono()}
            onChange={(value) => settings.appearance.setFont(value)}
            bundled={BUNDLED_MONO}
            candidates={CANDIDATE_MONO}
            fallbackDefault={monoDefault}
            previewFamily={monoFontFamily(settings.appearance.font())}
            label={language.t("settings.general.row.font.title")}
            action="settings-code-font"
            probe={fontProbe}
          />
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
          <FontPicker
            value={terminal()}
            onChange={(value) => settings.appearance.setTerminalFont(value)}
            bundled={BUNDLED_MONO}
            candidates={CANDIDATE_MONO}
            fallbackDefault={terminalDefault}
            previewFamily={terminalFontFamily(settings.appearance.terminalFont())}
            label={language.t("settings.general.row.terminalFont.title")}
            action="settings-terminal-font"
            probe={fontProbe}
          />
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
