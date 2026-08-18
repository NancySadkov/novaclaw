import { For, Show, createMemo, createResource, type Component } from "solid-js"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { authorText } from "@/apps/skills"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { policyState, type InstalledPolicy } from "@/utils/policy-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

/**
 * **Which checks run before a tool call, and which of them you have switched off.**
 *
 * `todo/projects.md`: *"Policies have no management surface … Settings cannot list or toggle them;
 * only built-ins install."* A pre-action policy can refuse a tool call, rewrite its arguments or
 * hold it for approval, and until this section existed there was no screen anywhere that said one
 * existed. It sits directly under Project because it answers the third form of the same question
 * those sections raise: what is deciding what the agent may do here.
 *
 * 🔴 **The in-force line comes BEFORE any control** (AGENTS.md principle 12d), and the copy CHANGES
 * with the switches — "all of them run" and "{{off}} switched off" are different sentences, because
 * a fixed line above a control that has moved is the trap principle 12 records from its first sweep.
 *
 * ⚠️ **A policy's description is the POLICY's sentence, not ours.** Only NovaClaw's built-ins
 * register today, but `ToolPolicy.Provider` is the interface a plugin implements — so every string
 * that came from one goes through `authorText`, and the copy quotes rather than asserts.
 */

const Value: Component<{ children: string }> = (props) => (
  <span class="text-[13px] text-v2-text-text-muted">{props.children}</span>
)

/** The joined id list, sanitized, for the sentences that name several at once. */
const idList = (ids: readonly string[]) => ids.map((id) => authorText(id, 64) || "?").join(", ")

export const SettingsPoliciesSection: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()

  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const directory = createMemo(() => sync().data.path.directory || sync().data.path.home || "")
  const source = createMemo(() => {
    const http = connection()?.http
    const dir = directory()
    return http && dir ? { http, dir } : undefined
  })

  /**
   * ⚠️ Degrades to `undefined` rather than throwing, exactly as Settings → Project's saved-rules
   * read does. A throw inside a `createResource` read reaches the ROOT ErrorBoundary and replaces
   * the whole application, and a policy list that failed to load must never cost someone their
   * chats. `undefined` renders nothing here, which is honest: this block has not been told, so it
   * claims nothing.
   */
  const [state, { refetch }] = createResource(source, async (value) => {
    try {
      return await policyState(value.http, value.dir)
    } catch {
      return undefined
    }
  })

  const installed = createMemo(() => state()?.installed ?? [])
  const off = createMemo(() => installed().filter((entry) => !entry.enabled).length)
  const requested = createMemo(() => new Set(state()?.requested ?? []))

  const inForce = createMemo(() => {
    if (installed().length === 0) return language.t("policies.inForce.none")
    if (off() === 0) return language.t("policies.inForce.all", { count: installed().length })
    return language.t("policies.inForce.some", { count: installed().length, off: off() })
  })

  /**
   * The switch write.
   *
   * ⚠️ Only the one id travels. `PATCH /config` merge-patches a settings key, so sending the whole
   * map would make this screen the author of every OTHER policy's row — including ones a future
   * build installed and this one has never heard of.
   *
   * ⚠️ `enabled: true` is written explicitly rather than clearing the row, because `PATCH /config`
   * treats `null` as a value and not as a tombstone (deleting is `POST /api/config/remove`). An
   * explicit `true` and an absent key mean the same thing to the gate.
   */
  const toggle = (id: string, enabled: boolean) => {
    void sync()
      .updateConfig({ tool_policy: { [id]: { enabled } } } as never)
      .then(() => refetch())
      .catch((error) => console.error("policy toggle failed", error))
  }

  const describe = (entry: InstalledPolicy) => {
    const sentence = authorText(entry.describe, 240)
    const parts = [
      sentence === "" ? "" : language.t("policies.row.describes", { describe: sentence }),
      entry.alwaysOn ? "" : language.t("policies.row.optIn"),
      entry.safetyCritical ? language.t("policies.row.safetyCritical") : language.t("policies.row.advisory"),
      // ⚠️ The row's own copy states the switch position too. A description that read the same
      // whether the policy was running or not is the "fixed copy beside a moved control" defect.
      entry.enabled ? "" : language.t("policies.row.off"),
      requested().has(entry.id) ? language.t("policies.row.requestedHere") : "",
    ]
    return parts.filter((part) => part !== "").join(" ")
  }

  return (
    <Show when={state()}>
      {(resolved) => (
        <div class="settings-v2-section" data-component="settings-policies">
          <h3 class="settings-v2-section-title">{language.t("policies.section")}</h3>

          <SettingsListV2>
            {/* 🔴 The fact FIRST, before any switch — principle 12(d). */}
            <SettingsRowV2 title={language.t("policies.inForce.title")} description={inForce()} hint={language.t("policies.hint")}>
              <Value>{String(resolved().installed.length)}</Value>
            </SettingsRowV2>

            <For each={resolved().installed}>
              {(entry) => (
                <SettingsRowV2
                  title={authorText(entry.id, 64) || entry.id}
                  description={describe(entry)}
                >
                  <div data-action="settings-policy-toggle" data-policy={entry.id}>
                    <Switch checked={entry.enabled} onChange={(checked) => toggle(entry.id, checked)} />
                  </div>
                </SettingsRowV2>
              )}
            </For>

            {/* What the FOLDER asks for is shown even when it asks for nothing — the same reason the
                "Never read" row above it is: a capability that only appears once you already use it
                teaches nobody that it exists. */}
            <SettingsRowV2
              title={language.t("policies.folder.title")}
              description={
                resolved().requested.length === 0
                  ? language.t("policies.folder.none")
                  : language.t("policies.folder.requested", {
                      file: resolved().file ?? "novaclaw.json",
                      ids: idList(resolved().requested),
                    })
              }
            >
              <span />
            </SettingsRowV2>

            {/* 🔴 Both refusal states get their own row, and they are separate rows because the fix
                is the opposite one in each case: install the thing, or switch it back on. */}
            <Show when={resolved().missing.length > 0}>
              <SettingsRowV2
                title={language.t("policies.folder.missing.title")}
                description={language.t("policies.folder.missing", {
                  file: resolved().file ?? "novaclaw.json",
                  ids: idList(resolved().missing),
                })}
              >
                <span data-slot="settings-policy-missing" />
              </SettingsRowV2>
            </Show>
            <Show when={resolved().disabledButRequested.length > 0}>
              <SettingsRowV2
                title={language.t("policies.folder.disabled.title")}
                description={language.t("policies.folder.disabled", {
                  file: resolved().file ?? "novaclaw.json",
                  ids: idList(resolved().disabledButRequested),
                })}
              >
                <span data-slot="settings-policy-disabled" />
              </SettingsRowV2>
            </Show>
          </SettingsListV2>
        </div>
      )}
    </Show>
  )
}
