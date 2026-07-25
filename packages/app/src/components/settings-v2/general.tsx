import { Component, Show, createMemo, createResource, createSignal, onMount } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useExpertise, PERMISSION_MODE_MIN_LEVEL } from "@/context/expertise"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection, serverName } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { ConfigExportImport } from "./config-io"
import { useSettings } from "@/context/settings"
import { offlineStatus, shellProvision, shellStatus, type OfflineStatus, type ShellStatus } from "@/utils/fs-api"
import { useUpdaterAction } from "../updater-action"
import { Link } from "../link"
import { DialogExpertise } from "./dialog-expertise"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

type ShellSelectOption = {
  id: string
  value: string
  label: string
}

export const SettingsGeneralV2: Component<{
  sessionID?: string
}> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const expertise = useExpertise()
  const permission = usePermission()
  const platform = usePlatform()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSdk = useServerSDK()
  const mobile = createMediaQuery("(max-width: 767px)")

  const updater = useUpdaterAction()

  const dir = createMemo(() => {
    if (!props.sessionID) return undefined
    return serverSync().session.lineage.peek(props.sessionID)?.session.location.directory
  })
  const accepting = createMemo(() => {
    const value = dir()
    if (!value || !props.sessionID) return false
    return permission.isAutoAccepting(props.sessionID, value)
  })

  const toggleAccept = (checked: boolean) => {
    const value = dir()
    if (!value || !props.sessionID) return

    if (checked) {
      permission.enableAutoAccept(props.sessionID, value)
      return
    }

    permission.disableAutoAccept(props.sessionID, value)
  }
  const desktop = createMemo(() => platform.platform === "desktop")

  const [shells] = createResource(
    () =>
      serverSdk()
        .client.pty.shells()
        .then((res) => res.data ?? [])
        .catch(() => [] as ShellOption[]),
    { initialValue: [] as ShellOption[] },
  )

  // B11 — bundled-shell substrate status + provisioner (raw-fetch endpoints, not in the SDK).
  const globalCtx = useGlobal()
  const serverCtx = useServer()
  // Settings-IA (i) — the quick instance picker (tie-break #7, P2P vision): redirect the UI at
  // another known instance without opening the Instances tab. Hidden below two known instances —
  // a one-item select is dead UI; the Instances tab stays the place instances are ADDED.
  const serversCtl = useServerManagementController()
  const instanceOptions = createMemo(() =>
    serversCtl.sortedItems().map((item) => ({ value: ServerConnection.key(item), label: serverName(item), item })),
  )
  // The active key comes from the server context, not controller.current() — that memo is
  // undefined by design under newLayoutDesigns. Fall back to the first item like it does.
  const currentInstanceKey = createMemo(() => serverCtx.key ?? instanceOptions()[0]?.value)
  // Settings-IA (iv) — temp-switch legibility. The picker's select() is non-persisting, so a
  // switch is TEMPORARY: next launch boots the default. Surface that plainly — tag the default
  // option, and when the active instance is NOT the default, say so + offer a one-click return.
  // When no explicit platform default is stored (defaultKey() null — the common case), the boot
  // default IS what next launch connects to, so fall back to it: without this the notice never
  // rendered and a reload reverted silently (measured 2026-07-21).
  const defaultInstanceKey = createMemo(() => {
    if (!serversCtl.canDefault()) return serverCtx.defaultServer
    return serversCtl.defaultKey() ?? serverCtx.defaultServer
  })
  const defaultInstance = createMemo(() => instanceOptions().find((option) => option.value === defaultInstanceKey()))
  const tempSwitched = createMemo(
    () => !!defaultInstanceKey() && !!currentInstanceKey() && currentInstanceKey() !== defaultInstanceKey(),
  )
  const returnToDefault = () => {
    const target = defaultInstance()
    if (target) void serversCtl.select(target.item)
  }
  const shellConn = createMemo(() => serverCtx.current ?? globalCtx.servers.list()[0])
  const shellRouteDir = createMemo(() => {
    const conn = shellConn()
    if (!conn) return undefined
    const ctx = globalCtx.ensureServerCtx(conn)
    const p = ctx.sync.data.path as { directory?: string; home?: string } | undefined
    return p?.directory || p?.home || undefined
  })
  const [provisioning, setProvisioning] = createSignal(false)
  const [bundle, { refetch: refetchBundle }] = createResource(
    () => (shellConn() && shellRouteDir() ? { conn: shellConn()!, d: shellRouteDir()! } : undefined),
    ({ conn, d }) => shellStatus(conn.http, { directory: d }).catch(() => undefined),
  )
  const bundleLabel = createMemo(() => {
    const status = bundle.latest as ShellStatus | undefined
    if (!status) return language.t("settings.general.row.shellBundle.unknown")
    if (status.bundle)
      return `${language.t("settings.general.row.shellBundle.bundled")}${status.bundle.version ? ` ${status.bundle.version}` : ""}`
    if (status.bash) return `${language.t("settings.general.row.shellBundle.system")} (${status.bash})`
    return language.t("settings.general.row.shellBundle.none")
  })
  const provisionShell = async () => {
    const conn = shellConn()
    const d = shellRouteDir()
    if (!conn || !d || provisioning()) return
    setProvisioning(true)
    try {
      await shellProvision(conn.http, { directory: d })
    } catch (error) {
      console.error("shell provision failed", error)
    } finally {
      setProvisioning(false)
      void refetchBundle()
    }
  }

  // OFF-C — the N/9 airgap-layer indicator (refetches when offline mode is toggled).
  const offlineEnabled = createMemo(() => (serverSync().data.config as { offline?: boolean }).offline === true)
  const [offline] = createResource(
    () => (shellConn() && shellRouteDir() ? { conn: shellConn()!, d: shellRouteDir()!, on: offlineEnabled() } : undefined),
    ({ conn, d }) => offlineStatus(conn.http, { directory: d }).catch(() => undefined),
  )
  const offlineLabel = createMemo(() => {
    const status = offline.latest as OfflineStatus | undefined
    if (!status) return ""
    return status.enabled
      ? `${language.t("settings.general.row.offline.active")} — ${status.active}/${status.total}`
      : language.t("settings.general.row.offline.inactive")
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  // 1K: the default-permission-mode options reuse the composer droplist's labels. Expertise-gated
  // (uix.md §6.4) — Normal sees plan/ask, Advanced +surgical, Developer +bypass/yolo — but a stored
  // value above the level stays listed so the picker reflects the truth (the honesty valve nudges review).
  const permissionModeOptions = createMemo(() => {
    const current = settings.general.defaultPermissionMode()
    return (["plan", "ask", "surgical", "bypass", "yolo"] as const)
      .filter((mode) => mode === current || expertise.atLeast(PERMISSION_MODE_MIN_LEVEL[mode] ?? "normal"))
      .map((mode) => ({ id: mode, label: language.t(`prompt.permissionMode.${mode}`) }))
  })
  // Honesty valve (uix.md §6.5): a "run without asking" mode is active but its picker option would be
  // hidden at this level — surface a one-liner rather than silently masking a safety-relevant choice.
  const hiddenDangerMode = createMemo(() => {
    const current = settings.general.defaultPermissionMode()
    const min = PERMISSION_MODE_MIN_LEVEL[current] ?? "normal"
    return !expertise.atLeast(min)
  })
  const currentShell = createMemo(() => serverSync().data.config.shell ?? "")

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.latest
    const current = serverSync().data.config.shell

    const nameCounts = new Map<string, number>()
    for (const s of list) {
      nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }

    const options = [
      autoOption,
      ...list.map((s) => {
        const ambiguousName = (nameCounts.get(s.name) || 0) > 1
        const text = ambiguousName ? s.path : s.name
        const label = s.acceptable ? text : `${text} (${language.t("settings.general.row.shell.terminalOnly")})`
        return {
          id: s.path,
          // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
          value: ambiguousName ? s.path : s.name,
          label,
        }
      }),
    ]

    if (current && !options.some((o) => o.value === current)) {
      options.push({ id: current, value: current, label: current })
    }

    return options
  })

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  // Feed expansion prefs (reasoning folds / tool cards): "auto" = the expertise-level default.
  const feedDisplayOptions = createMemo(() => [
    { value: "auto" as const, label: language.t("settings.general.feedDisplay.auto") },
    { value: "expanded" as const, label: language.t("settings.general.feedDisplay.expanded") },
    { value: "collapsed" as const, label: language.t("settings.general.feedDisplay.collapsed") },
  ])

  // Dynamic i18n keys (level name/blurb) need the loose-key cast the translator otherwise forbids.
  const tk = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  // push (not show) so it STACKS over Settings instead of disposing it — see ui/context/dialog.tsx.
  const openExpertise = () => dialog.push(() => <DialogExpertise />)

  const GeneralSection = () => (
    <div class="settings-v2-section">
      <SettingsListV2>
        {/* Experience level — the progressive-disclosure control (uix.md §6.2), first row so the
            friendliest surface is what a new user meets. */}
        <SettingsRowV2
          title={language.t("settings.expertise.title")}
          description={`${tk(`settings.expertise.level.${expertise.level()}.name`)} — ${tk(`settings.expertise.level.${expertise.level()}.blurb`)}`}
        >
          <ButtonV2 size="normal" variant="neutral" data-action="settings-expertise-change" onClick={openExpertise}>
            {language.t("settings.expertise.change")}
          </ButtonV2>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-language"
            options={languageOptions()}
            placement="bottom-end"
            gutter={6}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
          />
        </SettingsRowV2>

        <Show when={instanceOptions().length > 1}>
          <SettingsRowV2
            title={language.t("settings.general.row.instance.title")}
            description={
              <Show
                when={tempSwitched()}
                fallback={language.t("settings.general.row.instance.description")}
              >
                <span class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span>
                    {language.t("settings.general.row.instance.temporary", {
                      default: serverName(defaultInstance()!.item),
                    })}
                  </span>
                  <button
                    type="button"
                    data-action="settings-instance-return-default"
                    class="text-v2-text-text-accent underline underline-offset-2 hover:opacity-80"
                    onClick={returnToDefault}
                  >
                    {language.t("settings.general.row.instance.return")}
                  </button>
                </span>
              </Show>
            }
          >
            <SelectV2
              appearance="inline"
              data-action="settings-instance-switch"
              options={instanceOptions()}
              placement="bottom-end"
              gutter={6}
              current={instanceOptions().find((option) => option.value === currentInstanceKey())}
              value={(option) => option.value}
              label={(option) =>
                option.value === defaultInstanceKey()
                  ? `${option.label} · ${language.t("settings.general.row.instance.default")}`
                  : option.label
              }
              onSelect={(option) => {
                if (option && option.value !== currentInstanceKey()) void serversCtl.select(option.item)
              }}
            />
          </SettingsRowV2>
        </Show>

        <SettingsRowV2
          minLevel="advanced"
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t("toast.permissions.autoaccept.on.description")}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          minLevel="developer"
          title={language.t("settings.general.row.shell.title")}
          description={language.t("settings.general.row.shell.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-shell"
            options={shellOptions()}
            current={shellOptions().find((o) => o.value === currentShell()) ?? autoOption}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === currentShell()) return
              serverSync().updateConfig({ shell: option.value })
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          minLevel="developer"
          title={language.t("settings.general.row.shellBundle.title")}
          description={`${language.t("settings.general.row.shellBundle.description")} — ${bundleLabel()}`}
        >
          <Show when={(bundle.latest as ShellStatus | undefined)?.provisionSupported}>
            <div data-action="settings-shell-bundle-provision">
              <ButtonV2
                size="small"
                variant="outline"
                disabled={provisioning()}
                onClick={() => void provisionShell()}
              >
                {provisioning()
                  ? language.t("settings.general.row.shellBundle.provisioning")
                  : (bundle.latest as ShellStatus | undefined)?.bundle
                    ? language.t("settings.general.row.shellBundle.reprovision")
                    : language.t("settings.general.row.shellBundle.provision")}
              </ButtonV2>
            </div>
          </Show>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.defaultPermissionMode.title")}
          description={language.t("settings.general.row.defaultPermissionMode.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-default-permission-mode"
            options={permissionModeOptions()}
            current={permissionModeOptions().find((mode) => mode.id === settings.general.defaultPermissionMode())}
            placement="bottom-end"
            gutter={6}
            value={(option) => option.id}
            label={(option) => option.label}
            onSelect={(option) => {
              if (option) settings.general.setDefaultPermissionMode(option.id)
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.paranoid.title")}
          description={language.t("settings.general.row.paranoid.description")}
        >
          <div data-action="settings-paranoid">
            <Switch
              checked={(serverSync().data.config as { paranoid?: boolean }).paranoid === true}
              onChange={(checked) => void serverSync().updateConfig({ paranoid: checked } as never)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          minLevel="advanced"
          title={language.t("settings.general.row.offline.title")}
          description={`${language.t("settings.general.row.offline.description")}${offlineLabel() ? ` — ${offlineLabel()}` : ""}`}
        >
          <div data-action="settings-offline-mode">
            <Switch
              checked={offlineEnabled()}
              onChange={(checked) => void serverSync().updateConfig({ offline: checked } as never)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          minLevel="developer"
          title={language.t("settings.general.row.virtualFs.title")}
          description={language.t("settings.general.row.virtualFs.description")}
        >
          <div data-action="settings-virtual-fs">
            <Switch
              checked={(serverSync().data.config as { virtualFs?: boolean }).virtualFs === true}
              onChange={(checked) => void serverSync().updateConfig({ virtualFs: checked } as never)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          minLevel="developer"
          title={language.t("settings.general.row.telemetry.title")}
          description={language.t("settings.general.row.telemetry.description")}
        >
          <div data-action="settings-telemetry">
            <Switch
              checked={(serverSync().data.config as { telemetry?: { enabled?: boolean } }).telemetry?.enabled !== false}
              onChange={(checked) => void serverSync().updateConfig({ telemetry: { enabled: checked } } as never)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.feedReasoning.title")}
          description={language.t("settings.general.row.feedReasoning.description")}
        >
          <div data-action="settings-feed-reasoning-display">
            <SelectV2
              appearance="inline"
              options={feedDisplayOptions()}
              placement="bottom-end"
              gutter={6}
              current={feedDisplayOptions().find((o) => o.value === settings.general.feedReasoningDisplay())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => {
                // Kobalte re-emits unchanged values when options recreate — diff before writing.
                if (option && option.value !== settings.general.feedReasoningDisplay())
                  settings.general.setFeedReasoningDisplay(option.value)
              }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.feedTool.title")}
          description={language.t("settings.general.row.feedTool.description")}
        >
          <div data-action="settings-feed-tool-display">
            <SelectV2
              appearance="inline"
              options={feedDisplayOptions()}
              placement="bottom-end"
              gutter={6}
              current={feedDisplayOptions().find((o) => o.value === settings.general.feedToolDisplay())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => {
                if (option && option.value !== settings.general.feedToolDisplay())
                  settings.general.setFeedToolDisplay(option.value)
              }}
            />
          </div>
        </SettingsRowV2>

        <Show when={mobile() && import.meta.env.VITE_NOVACLAW_CHANNEL !== "prod"}>
          <SettingsRowV2
            title={language.t("settings.general.row.mobileTitlebarBottom.title")}
            description={language.t("settings.general.row.mobileTitlebarBottom.description")}
          >
            <div data-action="settings-mobile-titlebar-bottom">
              <Switch
                checked={settings.general.mobileTitlebarPosition() === "bottom"}
                onChange={(checked) => settings.general.setMobileTitlebarPosition(checked ? "bottom" : "top")}
              />
            </div>
          </SettingsRowV2>
        </Show>

        {/* Honesty valve (uix.md §6.5): a "run without asking" default is active while its option is
            hidden at this level — one quiet line so an active safety-relevant choice is never masked. */}
        <Show when={hiddenDangerMode()}>
          <SettingsRowV2
            title={language.t("settings.expertise.activeHidden.title")}
            description={language.t("settings.expertise.activeHidden.description")}
          >
            <ButtonV2 size="normal" variant="outline" onClick={openExpertise}>
              {language.t("settings.expertise.change")}
            </ButtonV2>
          </SettingsRowV2>
        </Show>

        {/* One discoverability affordance (uix.md §6.5): a quiet nudge to the next level; gone at
            Developer. No scattered lock icons. */}
        <Show when={!expertise.atLeast("developer")}>
          <SettingsRowV2
            title={
              expertise.atLeast("advanced")
                ? language.t("settings.expertise.discover.developer.title")
                : language.t("settings.expertise.discover.advanced.title")
            }
            description={
              expertise.atLeast("advanced")
                ? language.t("settings.expertise.discover.developer.description")
                : language.t("settings.expertise.discover.advanced.description")
            }
          >
            <ButtonV2 size="normal" variant="outline" data-action="settings-expertise-discover" onClick={openExpertise}>
              {language.t("settings.expertise.discover.action")}
            </ButtonV2>
          </SettingsRowV2>
        </Show>
      </SettingsListV2>
    </div>
  )

  // Removed per the settings vision (bootstrap · manage · reset): the Advanced dev-view toggles
  // (file tree / search / status / custom agents) and the Display pinch-zoom row. Chrome visibility
  // is the layout's job; a user who wants a different surface asks an agent for it.
  const NotificationsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const UpdatesSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.updates")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <ButtonV2 size="normal" variant="neutral" disabled={!updater.action().run} onClick={updater.run}>
            {language.t(updater.action().label)}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.general")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <GeneralSection />

        <NotificationsSection />

        {/* Whole-instance config Export/Import (moved from the Models tab, owner 2026-07-22 —
            it is general configuration, not a models tool). Desktop-gated with Updates: the
            component drives the native file pickers (window.api), absent on web. */}
        <Show when={desktop()}>
          <div class="settings-v2-section">
            <SettingsListV2>
              <SettingsRowV2
                minLevel="developer"
                title={language.t("settings.general.row.configIO.title")}
                description={language.t("settings.general.row.configIO.description")}
              >
                <div data-action="settings-config-io">
                  <ConfigExportImport />
                </div>
              </SettingsRowV2>
            </SettingsListV2>
          </div>

          <UpdatesSection />
        </Show>
      </div>
    </>
  )
}
