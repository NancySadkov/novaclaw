import { Component, Show, createMemo, createResource, createSignal, onMount } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useGlobal } from "@/context/global"
import { ReleaseNotesStatusLine } from "@/context/highlights"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection, serverName } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { ConfigExportImport } from "./config-io"
import { SettingsProjectSection } from "./project"
import { SettingsPoliciesSection } from "./policies"
// Confinement is no longer rendered here — it is part of the health report now. `ShellStatus` below
// still types the shell-BUNDLE row's own fetch, which stays in this tab because it has a control.
import { useSettings } from "@/context/settings"
import { offlineStatus, shellProvision, shellStatus, type OfflineStatus, type ShellStatus } from "@/utils/fs-api"
import { Link } from "../link"
import { DialogExpertise } from "./dialog-expertise"
import { DialogTelemetryStatus, type TelemetryStatus } from "./dialog-telemetry-status"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { useSettingsConfigWrite } from "./parts/config-write"
import { SettingsExplainV2 } from "./explain"
import { scopedDirectory } from "@/utils/routing-directory"
import { ControlScope } from "../control-scope"

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
  /**
   * Switch the settings dialog to another tab.
   *
   * Only one row uses it — the health pointer at the top of this tab — and it exists so that moving
   * the health report out of General did not cost the discoverability the report's old placement
   * bought. Optional so a caller that renders this panel outside the dialog still compiles; the
   * button simply does nothing there, which is the right failure for a pure navigation affordance.
   */
  onOpenTab?: (tab: string) => void
}> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const expertise = useExpertise()
  const platform = usePlatform()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const writeConfig = useSettingsConfigWrite()
  const serverSdk = useServerSDK()
  const mobile = createMediaQuery("(max-width: 767px)")

  const desktop = createMemo(() => platform.platform === "desktop")

  const [shells] = createResource(
    () =>
      serverSdk()
        .client.v2.pty.shells()
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
  // The active key comes from the server context. (The picker controller used to expose a
  // `current()` memo too; it was hardwired to undefined in this layout and is gone.)
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
    // ⚠️ `|| undefined`, not `|| ""`, is the one variation in the eighteen sites that is NOT the
    // order — this memo gates a `createResource` on truthiness and its consumer types the directory
    // as `string | undefined`. `scopedDirectory` answers `""` for the same absence, so the coalesce
    // stays here rather than being pushed into the shared helper, where it would make every other
    // caller's `!directory()` check read a different value for the same condition.
    return scopedDirectory(ctx.sync.data.path) || undefined
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

  // OFF-C — the N/8 airgap-layer indicator (refetches when offline mode is toggled).
  const offlineEnabled = createMemo(() => (serverSync().data.config as { offline?: boolean }).offline === true)
  const [offline] = createResource(
    () =>
      shellConn() && shellRouteDir() ? { conn: shellConn()!, d: shellRouteDir()!, on: offlineEnabled() } : undefined,
    ({ conn, d }) => offlineStatus(conn.http, { directory: d }).catch(() => undefined),
  )
  const telemetryConsent = createMemo(
    () => (serverSync().data.config as { telemetry?: { enabled?: boolean } }).telemetry?.enabled !== false,
  )
  const [telemetryStatus] = createResource(
    () => {
      const d = shellRouteDir()
      return d ? { d, consent: telemetryConsent(), offline: offlineEnabled() } : undefined
    },
    () =>
      serverSdk()
        .client.v2.telemetry.status()
        .then((response) => response.data)
        .catch(() => undefined),
  )
  const telemetryStatusCopy = createMemo(() => {
    const status = telemetryStatus.latest as TelemetryStatus | undefined
    if (!status) return language.t("settings.general.row.telemetry.statusUnavailable")
    if (status.gate.airgap) return language.t("settings.general.row.telemetry.statusAirgap")
    if (!status.gate.consent) return language.t("settings.general.row.telemetry.statusConsentOff")
    if (!status.endpointConfigured) return language.t("settings.general.row.telemetry.statusNoEndpoint")
    if (!status.ready) return language.t("settings.general.row.telemetry.statusNotReady")
    return language.t("settings.general.row.telemetry.statusReady")
  })
  const offlineLabel = createMemo(() => {
    const status = offline.latest as OfflineStatus | undefined
    if (!status) return ""
    return status.enabled
      ? `${language.t("settings.general.row.offline.active")} — ${status.active}/${status.total}`
      : language.t("settings.general.row.offline.inactive")
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  // 1K: the default-permission-mode options reuse the composer droplist's labels.
  //
  // Every mode is offered at EVERY expertise level, and that is a standing decision, not an omission.
  // Permission modes escalate in danger, but only ONE of them leaves the project folder. External
  // writes are guarded independently of the mode (agent baseline asks; an unattended chain is
  // hard-denied — config-resolve.ts §UNATTENDED CONFINEMENT), so plan/ask/surgical/bypass all stay
  // INSIDE the folder and are safe to offer at any level. Gating `bypass` to Developer hid the one
  // mode most users actually want ("work in my project without asking me every time") and left Normal
  // with two options, which read as a broken picker. `yolo` is ungated for the same reason (owner
  // 2026-07-25 named all three postures as the set a normal user picks from): hiding the escape hatch
  // does not make it safer, it makes the honest one unreachable. What carries the weight is the LABEL
  // — "Admin" reads with the hint "Write access to the ENTIRE computer, not just this project". The
  // real containment work is tracked for v0.2.0 (jail bash in every non-YOLO mode, Windows included).
  const permissionModeOptions = createMemo(() =>
    (["plan", "ask", "surgical", "bypass", "yolo"] as const).map((mode) => ({
      id: mode,
      label: language.t(`prompt.permissionMode.${mode}`),
    })),
  )
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

  // push (not show) so it STACKS over Settings instead of disposing it — see ui/context/dialog.tsx.
  const openExpertise = () => dialog.push(() => <DialogExpertise />)

  const GeneralSection = () => (
    <div class="settings-v2-section">
      <SettingsListV2>
        {/* Experience level — the progressive-disclosure control (uix.md §6.2), first row so the
            friendliest surface is what a new user meets. */}
        <SettingsRowV2
          title={language.t("settings.expertise.title")}
          description={`${language.t(`settings.expertise.level.${expertise.level()}.name`)} — ${language.t(`settings.expertise.level.${expertise.level()}.blurb`)}`}
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
              <span class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <ControlScope kind="window" />
                <Show when={tempSwitched()} fallback={language.t("settings.general.row.instance.description")}>
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
                </Show>
              </span>
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
              void writeConfig({ shell: option.value })
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
              <ButtonV2 size="small" variant="outline" disabled={provisioning()} onClick={() => void provisionShell()}>
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
          description={
            <>
              {language.t("settings.general.row.defaultPermissionMode.description")}
              <SettingsExplainV2 label={language.t("settings.general.row.defaultPermissionMode.title")}>
                {language.t("settings.general.row.defaultPermissionMode.description.more")}
              </SettingsExplainV2>
            </>
          }
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
          minLevel="advanced"
          title={language.t("settings.general.row.offline.title")}
          description={
            <details>
              <summary class="cursor-pointer">
                {offlineLabel() || language.t("settings.general.row.offline.title")}
              </summary>
              <p>{language.t("settings.general.row.offline.description")}</p>
            </details>
          }
        >
          <div data-action="settings-offline-mode">
            <Switch checked={offlineEnabled()} onChange={(checked) => void writeConfig({ offline: checked })} />
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
              onChange={(checked) => void writeConfig({ virtualFs: checked })}
            />
          </div>
        </SettingsRowV2>

        {/* The disclosure is ordinary-user UI. It is deliberately a separate row from the
          Developer-only switch below, because SettingsRowV2 hides its entire subtree at minLevel. */}
        <SettingsRowV2 title={language.t("settings.general.row.telemetry.title")} description={telemetryStatusCopy()}>
          <ButtonV2
            variant="outline"
            disabled={!telemetryStatus.latest}
            onClick={() => {
              const status = telemetryStatus.latest as TelemetryStatus | undefined
              if (status) dialog.show(() => <DialogTelemetryStatus status={status} />)
            }}
          >
            {language.t("settings.general.row.telemetry.inspect")}
          </ButtonV2>
        </SettingsRowV2>

        {/*
          The disable switch is Developer-gated by design (AGENTS.md design-principle 4: on by
          default, disableable only in Developer mode — a common user is maintained, not
          handed a pager).

          ⚠️ Airgap is shown as an OVERRIDE, not as the toggle's value. Rendering `checked={false}`
          while offline is on would tell the user they withdrew consent when they did not — the two
          conditions are independent (`core/src/observability/telemetry.ts`), and a surface that
          collapses them is how the independence gets refactored away later.
        */}
        <SettingsRowV2
          minLevel="developer"
          title={language.t("settings.general.row.telemetry.controlTitle")}
          description={`${language.t("settings.general.row.telemetry.controlDescription")}${
            offlineEnabled() ? ` — ${language.t("settings.general.row.telemetry.forcedOff")}` : ""
          }`}
        >
          <div data-action="settings-telemetry">
            <Switch
              checked={telemetryConsent()}
              disabled={offlineEnabled()}
              onChange={(checked) => void writeConfig({ telemetry: { enabled: checked } })}
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
          description={
            // ⚠️ The status sentence is NOT written here. Both Settings panels render the same
            // `ReleaseNotesStatusLine`, so the v1 and v2 rows cannot come to say different things
            // about one subsystem — pinned by components/settings-release-notes-row.test.ts.
            <>
              {language.t("settings.general.row.releaseNotes.description")}
              <ReleaseNotesStatusLine />
            </>
          }
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
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
        {/* ─────────────────────────────────────────────────────────────────────────────────────
            🔴 WHAT THIS TAB IS FOR (decided 2026-08-19, owner-driven; principle 10 — a
            vision-answerable question is a mandatory action, not an escalation).

            **General is what you SET.** Every row below is a control: a preference, a switch, a
            picker, a button. That is the whole membership rule, and it exists because General had
            stopped having one — it had become the tab things landed in when they had no obvious
            home, which is how a tab stops being navigable.

            The symptom that made it visible was two READ-ONLY STATUS BOARDS living here (Nova Health
            and Confinement) in the tab you open in order to change something. So the rule was
            decided for the CLASS rather than for one board: **a read-only reading of this instance
            is a FINDING, and findings go in the health report** (`nova-health.tsx`), **which lives
            in Health & recovery** — the tab whose whole subject is "something is wrong, help me fix
            it", and which `uix.md` §7 already labelled *understand + reset*. Confinement went one
            step further at the owner's instruction and is now three ROWS of that report rather than
            a board beside it, because it never had a control in it at all.

            The next status board goes into the report too. It does not come back here.

            ⚠️ WHAT DELIBERATELY STAYED, so the rule is not read as "move anything that shows a
            fact": Project and Policies are NOT status boards. Both carry real controls — Project
            writes `novaclaw.json` (rules, the excluded-path list, the .gitignore import) and Policies
            is the other agent's live surface — and their fact rows are the context those controls
            need. A control with an explanation is a setting; an explanation with no control is a
            finding. Storage stays where it is for the same reason it always did: it has an unload
            button and is already in the Safety section.

            ⚠️ AND THE DISCOVERABILITY ARGUMENT THAT USED TO PIN HEALTH HERE SURVIVES — it was the
            right argument (a worried user must not read a language picker first) and it is now
            carried by three things instead of one: the report LEADS its new tab, the tab is NAMED
            "Health & recovery" so the rail states the question, and the row directly below is the
            first thing in General — a pointer, one click, before any preference.
            ───────────────────────────────────────────────────────────────────────────────────── */}
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.general.row.health.title")}
              description={
                <>
                  {language.t("settings.general.row.health.description")}
                  <SettingsExplainV2 label={language.t("settings.general.row.health.title")}>
                    {language.t("settings.general.row.health.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <ButtonV2
                size="normal"
                variant="neutral"
                data-action="settings-open-health"
                onClick={() => props.onOpenTab?.("recovery")}
              >
                {language.t("settings.general.row.health.action")}
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <GeneralSection />

        {/* Confinement used to sit here, directly under the safety rows above. It is now part of the
            health report (see the block at the top of this tab) — it was a read-only reading with no
            control in it, which makes it a finding rather than a setting. `bundle` below is still
            fetched for the shell-BUNDLE row inside GeneralSection; the report makes its own
            `shell/status` call, which is named as a cost in `nova-health.tsx` rather than hidden. */}

        {/* Directly after the settings above, because it answers the same question from the other side: not
            "what boxes the agent in", but "what ELSE is deciding what it may do here". A folder's
            `novaclaw.json` can narrow this session's permissions, and until this section existed the
            only way to discover that was to be refused and go looking for the file. */}
        <SettingsProjectSection
          shellStatus={bundle.latest}
          onOpenConfinement={props.onOpenTab ? () => props.onOpenTab?.("recovery") : undefined}
        />

        {/* And directly after Project, because it is the THIRD answer to the same question those two
            raise — not "what boxes the agent in" or "what does this folder narrow", but "what looks
            at each tool call before it happens". A pre-action policy could already refuse a call,
            rewrite its arguments or hold it for approval, and no screen anywhere said one existed. */}
        <SettingsPoliciesSection />

        <NotificationsSection />

        {/* Whole-instance config Export/Import (moved from the Models tab, owner 2026-07-22 —
            it is general configuration, not a models tool). Desktop-gated on its own account: the
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
        </Show>

        {/* Updates is NOT desktop-gated as a whole (2026-07-28). It was until today, and that hid the
            release-notes toggle and its status row on web in THIS panel while the v1 panel showed them
            — the exact drift the shared status component was supposed to make impossible, and it did
            not, because a shared component stops two panels SAYING different things and does nothing
            to stop one of them from not saying it at all.
            Release notes are not an update mechanism; they are the product telling you what changed,
            and the subsystem behind that toggle runs on web — HighlightsProvider is mounted for every
            entry point and fetches novaclaw.app/changelog.json on a version change, on by default. So
            gating the section left a web user with a live outbound request they could not switch off
            and no answer to "did the release notes work?". Only the update-CHECK row inside is
            desktop-only. Both panels must agree on this: components/settings-release-notes-row.test.ts
            resolves the gate path through the section component and fails if they diverge. */}
        <UpdatesSection />
      </div>
    </>
  )
}
