import { Component, Show, createMemo, createResource, onMount } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { ServerConnection, serverName } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { ConfigExportImport } from "./config-io"
import { SettingsPoliciesSection } from "./policies"
import { SettingsProfileSection } from "./profile"
import { useSettings } from "@/context/settings"
import { offlineStatus, type OfflineStatus } from "@/utils/fs-api"
import { Link } from "../link"
import { DialogExpertise } from "./dialog-expertise"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { useSettingsConfigWrite } from "./parts/config-write"
import { SettingsExplainV2 } from "./explain"
import { scopedDirectory } from "@/utils/routing-directory"
import { ControlScope } from "../control-scope"

export const SettingsGeneralV2: Component<{
  /**
   * Switch the settings screen to another tab.
   *
   * Only one row uses it — the health pointer at the top of this tab — and it exists so that moving
   * the health report out of General did not cost the discoverability the report's old placement
   * bought. Optional so a caller that renders this panel outside the screen still compiles; the
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
  const mobile = createMediaQuery("(max-width: 767px)")

  const desktop = createMemo(() => platform.platform === "desktop")

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
  const instanceConn = createMemo(() => serverCtx.current ?? globalCtx.servers.list()[0])
  const instanceRouteDir = createMemo(() => {
    const conn = instanceConn()
    if (!conn) return undefined
    const ctx = globalCtx.ensureServerCtx(conn)
    // ⚠️ `|| undefined`, not `|| ""`, is the one variation in the eighteen sites that is NOT the
    // order — this memo gates a `createResource` on truthiness and its consumer types the directory
    // as `string | undefined`. `scopedDirectory` answers `""` for the same absence, so the coalesce
    // stays here rather than being pushed into the shared helper, where it would make every other
    // caller's `!directory()` check read a different value for the same condition.
    return scopedDirectory(ctx.sync.data.path) || undefined
  })
  // OFF-C — the airgap-layer indicator (refetches when offline mode is toggled).
  const offlineEnabled = createMemo(() => (serverSync().data.config as { offline?: boolean }).offline === true)
  const [offline] = createResource(
    () =>
      instanceConn() && instanceRouteDir()
        ? { conn: instanceConn()!, d: instanceRouteDir()!, on: offlineEnabled() }
        : undefined,
    ({ conn, d }) => offlineStatus(conn.http, { directory: d }).catch(() => undefined),
  )
  const offlineLabel = createMemo(() => {
    const status = offline.latest as OfflineStatus | undefined
    if (!status) return ""
    return status.enabled
      ? `${language.t("settings.general.row.offline.active")} — ${status.active}/${status.total}`
      : language.t("settings.general.row.offline.inactive")
  })

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

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
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.section.notifications")}
          description={language.t("settings.general.notifications.description")}
        >
          <div data-action="settings-notifications">
            <Switch
              checked={settings.notifications.enabled()}
              onChange={(checked) => settings.notifications.setEnabled(checked)}
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

        <SettingsProfileSection />

        {/* 🗑️ `SettingsProjectSection` stood here: the folder's own `novaclaw.json` — which file governs
            it, which rules it adds, which paths it forbids, and the `.gitignore` import. It went with the
            mechanism on 2026-09-16 (owner: *"Please ensure it is gone for good."*). The reason it lived
            in General rather than in a status board was that it carried CONTROLS; there are none left to
            carry, and nothing else answers "what else is deciding what it may do here". */}

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
      </div>
    </>
  )
}
