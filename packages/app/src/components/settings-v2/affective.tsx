import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { PresetFieldV2 } from "./parts/preset-field"
import { presetWrite } from "./parts/preset-value"
import { SettingsExplainV2 } from "./explain"

// P3 (3D) — the Affective settings tab. When enabled, a per-session mood (appraised from tool
// errors, repeats, time-on-task) modulates sampling around the model's configured baseline and
// steers a redirect at high frustration/urgency (3A/3B). Edits the 3C `affective` config.
//
// 🔴 **Clearing the temperature is a DELETE, not a written `0`.** This tab used to
// persist `0` for an empty box and rely on `session/runner/llm.ts` reading it back through
// `|| undefined` — a real value borrowed to mean "absent", on the argument that "updateGlobal can't
// remove keys over the wire". That argument was wrong: `PATCH /config` indeed merges and can never
// delete, but `POST /api/config/remove` is the deletion verb and has been there all along (the PATCH
// route's own 400 for a `null` value points at it by name). So the sentinel bought nothing and cost
// the ability to ever set a real temperature of 0 — which is exactly `precise`, the first named
// preset in the shared control this row now uses.
//
// ⚠️ **Upgrade note, stated rather than migrated:** an instance that stored `affective.temperature:
// 0` under the OLD semantics meant "cleared", and now means `precise`. There is no migration,
// because the tab's old input coerced with `parsed > 0 ? parsed : 0` — a deliberate 0 was NOT
// expressible, so nothing is being reinterpreted that a user actually chose — and one click on
// "Default" restores it.

interface AffectiveConfig {
  enabled?: boolean
  temperature?: number
  extended?: boolean
}

export const SettingsAffectiveV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const sdk = useServerSDK()

  const current = (): AffectiveConfig => (serverSync().data.config as { affective?: AffectiveConfig }).affective ?? {}

  const failed = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.affective.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  async function persist(patch: Partial<AffectiveConfig>) {
    const next = { ...current(), ...patch }
    for (const key of Object.keys(next) as Array<keyof AffectiveConfig>) if (next[key] === undefined) delete next[key]
    await serverSync()
      .updateConfig({ affective: next } as never)
      .catch(failed)
  }

  /**
   * Drop one key out of `affective`. The second verb — `PATCH /config` merges, so an omitted key is
   * "unchanged", never "gone".
   *
   * ⚠️ Followed by an explicit re-read: this write does not go through `updateConfig`, so nothing
   * else refreshes the config the tab renders from, and the row would keep showing the value the
   * server no longer has. `refetchConfig` documents itself as existing for exactly this case.
   */
  async function clear(key: keyof AffectiveConfig) {
    // ⚠️ Nothing to delete — and this is not defensive padding. `POST /api/config/remove` answers
    // **400** for a path that names nothing ("NOTHING was removed … rolled back rather than report
    // success"), which is the right contract: a delete that matched nothing must not report success.
    // But it means asking to clear an already-absent key turns a correct state into a reported
    // FAILURE the user sees as a toast. Measured live 2026-09-01: one gesture on this tab reaches its
    // handler TWICE (six PATCHes for three keystrokes, two for one switch click), and the second
    // clear hit exactly that 400. That duplicate-write cause is still open and is NOT this guard —
    // this guard is why it is no longer visible to the user. Where
    // one gesture on this tab reaches the handler twice and the second clear hit exactly that 400.
    if (current()[key] === undefined) return
    const client = sdk()
    if (!client) return failed(new Error(language.t("settings.affective.toast.failed")))
    try {
      await client.client.v2.config.remove({ configRemoveRequest: { paths: [["affective", key]] } })
      await (serverSync().refetchConfig() as Promise<unknown>)
    } catch (error) {
      failed(error)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.affective.title")}</h2>
        <p class="settings-v2-tab-description">
          {language.t("settings.affective.description")}
          <SettingsExplainV2 label={language.t("settings.affective.title")}>
            {language.t("settings.affective.description.more")}
          </SettingsExplainV2>
        </p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.affective.row.enabled.title")}
              description={language.t("settings.affective.row.enabled.description")}
            >
              <Switch
                checked={current().enabled === true}
                onChange={(checked) => void persist({ enabled: checked })}
                hideLabel
              >
                {language.t("settings.affective.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.affective.row.temperature.title")}
              description={language.t("settings.affective.row.temperature.description")}
            >
              <PresetFieldV2
                field="temperature"
                value={() => (current().temperature === undefined ? "" : String(current().temperature))}
                onValue={(next) => {
                  const write = presetWrite(next)
                  void (write.kind === "clear" ? clear("temperature") : persist({ temperature: write.value }))
                }}
                ariaLabel={language.t("settings.affective.row.temperature.title")}
                // ⚠️ Not the default. This tab's `onValue` is a NETWORK write; per-keystroke would
                // send one PATCH per character and persist the half-typed values on the way.
                commit="change"
              />
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.affective.row.extended.title")}
              description={language.t("settings.affective.row.extended.description")}
            >
              <Switch
                checked={current().extended === true}
                onChange={(checked) => void persist({ extended: checked })}
                hideLabel
              >
                {language.t("settings.affective.row.extended.title")}
              </Switch>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
