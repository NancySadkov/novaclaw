import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { type Component, Show, createMemo } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

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

type PermissionEffect = "allow" | "ask" | "deny"

interface PermissionRule {
  action?: string
  resource?: string
  effect?: PermissionEffect
}

export const SettingsComputerV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

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
  const currentEffect = createMemo<PermissionEffect>(() => {
    const match = rules().find((rule) => rule.action === "computer")
    return match?.effect ?? "ask"
  })

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
    const next: PermissionRule[] = [
      { action: "computer", resource: "*", effect },
      ...rules().filter((rule) => rule.action !== "computer"),
    ]
    await save({ permissions: next }, language.t("settings.computer.save.failed"))
  }

  return (
    <div class="flex flex-col gap-y-4">
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.computer.display.name")}
          description={language.t("settings.computer.display.description")}
        >
          <TextInputV2
            value={config().display ?? ""}
            placeholder=":99"
            onChange={(event) =>
              void save(
                { computer: { ...config(), display: event.currentTarget.value.trim() || undefined } },
                language.t("settings.computer.save.failed"),
              )
            }
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.computer.screenshot.name")}
          description={language.t("settings.computer.screenshot.description")}
        >
          <TextInputV2
            value={config().screenshotPath ?? ""}
            placeholder="/tmp/novaclaw-computer.png"
            onChange={(event) =>
              void save(
                { computer: { ...config(), screenshotPath: event.currentTarget.value.trim() || undefined } },
                language.t("settings.computer.save.failed"),
              )
            }
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
          someone discover it from a failed turn. */}
      <Show when={!config().display}>
        <p class="text-13-regular text-text-weak-base px-1">{language.t("settings.computer.unset")}</p>
      </Show>
    </div>
  )
}
