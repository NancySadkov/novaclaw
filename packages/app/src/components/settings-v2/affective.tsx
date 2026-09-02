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

/**
 * Flat value comparison over the union of both key sets. `affective` is three scalars, so `!==` per
 * key is the whole of it — no recursion, and no `JSON.stringify` (key ORDER differs between the
 * object the server sends back and the one `{ ...current(), ...patch }` builds, which would make
 * every write look like a change).
 */
const sameConfig = (a: AffectiveConfig, b: AffectiveConfig) => {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AffectiveConfig>)
    if (a[key] !== b[key]) return false
  return true
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

  /**
   * 🔴 **A write that would not change the stored value is NOT sent.** This is the same rule
   * `clear()` below already applies to the delete verb — *never ask the server for a mutation that
   * does nothing* — and it is here because this tab is fed by a control that re-emits its own
   * selection when the store moves under it.
   *
   * ⚠️ The mechanism, measured, because a guard without one invites deletion. `PresetFieldV2` gives
   * `SelectV2` a freshly built option array (a "Custom (…)" entry appears and disappears with the
   * value, so `allOptions()` cannot be memoised on identity). Kobalte's `SelectBase` runs an effect
   * on every change of its option keys — *"delete selected keys that do not match any option"* —
   * which calls `setSelectedKeys`, and `SelectBase` defaults `allowDuplicateSelectionEvents` to
   * `true`, so that fires `onChange` **even when the selection is unchanged**. The tab writes → the
   * config re-reads → the option array is rebuilt → the droplist re-reports its selection → the tab
   * writes again. Live on 2026-09-01 that read as *one gesture, two `PATCH /global/config`*, and a
   * clear whose second `POST /api/config/remove` answered 400 for a path that no longer named
   * anything. It terminates at two only because TanStack Query's structural sharing hands back the
   * identical object on the second refetch; against a store that does not share structure it does
   * not terminate at all (measured in `test-browser/settings-affective-write-count.test.tsx`:
   * ten thousand PATCHes from one click).
   *
   * The re-entrant call always carries the value that was just written, so suppressing a no-op write
   * ends it at the first one. It does not suppress a real edit — the tests assert three distinct
   * commits still produce three writes.
   *
   * ⚠️ This closes the door on THIS tab's side. The re-entrant `onChange` itself lives in
   * `@novaclaw/ui/v2/select-v2`, which forwards Kobalte's pruning event as a user selection; any
   * other caller that pairs a reactively rebuilt option list with a remote write has the same defect.
   */
  async function persist(patch: Partial<AffectiveConfig>) {
    const before = current()
    const next = { ...before, ...patch }
    for (const key of Object.keys(next) as Array<keyof AffectiveConfig>) if (next[key] === undefined) delete next[key]
    if (sameConfig(before, next)) return
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
    // FAILURE the user sees as a toast — which is what a user saw on 2026-09-01, when one pick of
    // "Default" produced two removes and the second one 400'd.
    //
    // It stays now that the re-entry above is closed, as the delete-verb half of the same rule
    // `persist` states: never ask the server for a mutation that does nothing. Deleting it would
    // leave the two verbs on this tab disagreeing about that.
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
