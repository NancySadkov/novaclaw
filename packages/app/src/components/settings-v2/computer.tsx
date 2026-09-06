import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { type Component, Show, createMemo, createResource } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { shellStatus } from "@/utils/fs-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { effectOf, showsUnsetWarning, withEffect, type PermissionEffect, type PermissionRule } from "./computer-rules"
import { SettingsExplainV2 } from "./explain"

// The Computer Use settings tab.
//
// Two things live here and they are deliberately together, because they are the two halves of one
// question — *what may the agent see and click, and how much may it do without asking?*
//
//   1. **The display binding.** `computer.display` is the whole substrate binding (ruled 2026-08-06):
//      the tool drives a display THIS instance can reach, never a remote one, because a transport to
//      a box that runs commands for us is the client/server split an atomic instance forbids. To
//      drive a sandboxed desktop you run an instance inside the sandbox and reach it as a peer.
//   2. **The default permission.** Computer use is the one capability where "allow everything" means
//      an agent can click anything on a real screen, so the default is deliberately `ask`.
//
// ⚠️ Advanced/Developer only. A normal person has no display to bind and no reason to meet this; the
// expertise gate is the *meet each user at their level* clause, not a retreat from anti-elitism.
//
// Persisted with `updateConfig` — the golden config-write rule. `config.computer` is priced
// PRIVILEGED for the `configure` tool (ruling 4), because moving the display from a sandbox to `:0`
// promotes the agent from clicking inside a container to clicking on the operator's own desktop.
// That tier governs an AGENT writing it; a human at this tab is the operator, and this is their door.

interface ComputerConfig {
  display?: string
  screenshotPath?: string
}

export const SettingsComputerV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  // ⚠️ The INSTANCE's platform, not the browser's. This UI can be driving a headless Linux box from
  // a Windows desktop, and it is the instance that runs the shell commands being talked about.
  const server = useServer()
  const global = useGlobal()
  const [shell] = createResource(
    () => server.current ?? global.servers.list()[0],
    (conn) => shellStatus(conn.http, { directory: serverSync().data.path?.directory ?? "" }).catch(() => undefined),
  )
  const isWindows = createMemo(() => (shell()?.platform ?? "").toLowerCase() === "win32")

  const config = createMemo(() => (serverSync().data.config?.computer ?? {}) as ComputerConfig)
  const rules = createMemo(() => (serverSync().data.config?.permissions ?? []) as PermissionRule[])

  /**
   * The effect the ruleset currently gives `computer`.
   *
   * ⚠️ Read from the FIRST matching rule, because the ruleset is ORDERED and first-match-wins — the
   * same order the evaluator applies. Scanning for any rule mentioning the action would report a
   * later, shadowed rule as if it were in force, which is a settings screen lying about the system
   * it configures.
   */
  const currentEffect = createMemo<PermissionEffect>(() => effectOf(rules()))

  const effectOptions = createMemo(() =>
    (["ask", "allow", "deny"] as const).map((value) => ({
      id: value,
      value,
      label: language.t(`settings.computer.permission.${value}` as never),
    })),
  )

  const save = async (patch: Record<string, unknown>, failed: string) => {
    try {
      await serverSync().updateConfig(patch as never)
    } catch (error) {
      showToast({ title: failed, description: error instanceof Error ? error.message : String(error) })
    }
  }

  const setEffect = async (effect: PermissionEffect) => {
    // Replace this action's rule rather than appending: appending to an ordered, first-match-wins
    // list would leave the OLD rule in front and the new one dead — a control that appears to work
    // and changes nothing.
    await save({ permissions: withEffect(rules(), effect) }, language.t("settings.computer.save.failed"))
  }

  const saveField = async (key: keyof ComputerConfig, raw: string) => {
    const value = raw.trim()
    if (value) return save({ computer: { [key]: value } }, language.t("settings.computer.save.failed"))
    try {
      await serverSync().removeConfig([["computer", key]])
    } catch (error) {
      showToast({
        title: language.t("settings.computer.save.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    // ⚠️ Structure matches every sibling tab on purpose: a `settings-v2-tab-header`, then lists —
    // no extra flex wrapper. `settings-v2-panel` (the TabsV2.Content class) already owns the
    // column layout and spacing, and the wrapper this replaced fought it.
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.computer.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.computer.description")}</p>
      </div>

      <SettingsListV2>
        {/*
          On Windows the display is not asked for AT ALL, because it is not used: `tool/computer.ts`
          binds by executable basename there and never reads it. Showing the box would tell a
          Windows user their capability is off for want of a value that would change nothing.
        */}
        <Show
          when={!isWindows()}
          fallback={
            <SettingsRowV2
              title={language.t("settings.computer.display.name")}
              description={
                <>
                  {language.t("settings.computer.windows.description")}
                  <SettingsExplainV2 label={language.t("settings.computer.display.name")}>
                    {language.t("settings.computer.windows.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <span class="text-[13px] text-v2-text-text-muted">{language.t("settings.computer.windows.value")}</span>
            </SettingsRowV2>
          }
        >
          <SettingsRowV2
            title={language.t("settings.computer.display.name")}
            description={
              <>
                {language.t("settings.computer.display.description")}
                <SettingsExplainV2 label={language.t("settings.computer.display.name")}>
                  {language.t("settings.computer.display.description.more")}
                </SettingsExplainV2>
              </>
            }
          >
            <TextInputV2
              appearance="large"
              class="!w-full self-stretch"
              spellcheck={false}
              autocomplete="off"
              value={config().display ?? ""}
              placeholder=":99"
              onChange={(event) => void saveField("display", event.currentTarget.value)}
            />
          </SettingsRowV2>
        </Show>

        {/* Advanced: it already works. A row with a correct default that asks anyway is the same
            defect as one that asks for a value you cannot know — it implies a decision is required
            when none is. ⚠️ The placeholder is resolved by the INSTANCE, so a Windows instance must
            not be shown a POSIX path as if it were the default. */}
        <SettingsRowV2
          minLevel="advanced"
          title={language.t("settings.computer.screenshot.name")}
          description={language.t("settings.computer.screenshot.description")}
        >
          <TextInputV2
            appearance="large"
            class="!w-full self-stretch"
            spellcheck={false}
            autocomplete="off"
            value={config().screenshotPath ?? ""}
            placeholder={isWindows() ? "%TEMP%\\novaclaw-computer.png" : "/tmp/novaclaw-computer.png"}
            onChange={(event) => void saveField("screenshotPath", event.currentTarget.value)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.computer.permission.name")}
          description={language.t("settings.computer.permission.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-computer-permission"
            options={effectOptions()}
            current={effectOptions().find((o) => o.value === currentEffect()) ?? effectOptions()[0]}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option || option.value === currentEffect()) return
              void setEffect(option.value)
            }}
          />
        </SettingsRowV2>
      </SettingsListV2>

      {/* Ruling 2 — an unavailable subsystem names itself rather than rendering as if it were fine.
          With no display the tool declines every call, and saying so here is cheaper than letting
          someone discover it from a failed turn.

          🔴 …but NOT on Windows, where it was flatly false and contradicted the row above it on the
          same screen. `tool/computer.ts` binds a real desktop there by executable basename — `bind`
          refuses without `app` and never reads a display — and `resolveControlTarget` consults the
          session's `control_binding` FIRST, falling back to the instance display only as the SANDBOX
          default. So a Windows user with no display has working computer use, and was being told
          "computer use is off" two lines under "There is no display to set here".

          ⚠️ The generalizing rule is AGENTS.md design principle 12's: change the surrounding COPY
          with the control. The Windows row was added and the sentence beneath it kept describing the
          world before it. */}
      <Show when={showsUnsetWarning({ isWindows: isWindows(), display: config().display })}>
        <p class="settings-v2-field-description">{language.t("settings.computer.unset")}</p>
      </Show>
    </>
  )
}
