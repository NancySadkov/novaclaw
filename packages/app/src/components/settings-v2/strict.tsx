import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { type Component, Show, createSignal } from "solid-js"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"
import { type TranslationKey, useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsNumberFieldV2 } from "./parts/number-field"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"

// The Strict-mode settings tab (taxonomy E6 — every JH option user-surfaced). Strict mode is the
// Juvenile Harness posture for weak/local models (jh.md): the HARNESS owns decomposition, per-step
// compile/test verification, external correction, and recovery — the model is never asked to hold the
// whole horizon. This tab edits the `strict` config the harness reads (its group toggles map onto the
// engine lever families; see core/src/config/strict.ts). Patch-merge semantics as in the Affective tab.

interface StrictConfig {
  enabled?: boolean
  verification?: boolean
  recovery?: boolean
  editingAids?: boolean
  budgetSteering?: boolean
  wallMinutes?: number
  attempts?: number
  executionTokens?: number
  reasoningTokens?: number
}

const DEFAULT_WALL_MINUTES = 45
// Per-call GENERATION budgets — not the context window. A local model is typically served with 128k
// of context, but each call still needs room to FINISH its own reply, and the two step kinds fail in
// opposite ways when starved: execution truncates (half a file), reasoning returns EMPTY.
const DEFAULT_EXECUTION_TOKENS = 24_576
const MAX_TOKENS = 131_072

/** A preset is a RECOMMENDATION. 8192 is missing from the reasoning list because this tab's own
 *  description says it "returns empty" — naming a broken value would be worse than a bare box. */
const CUSTOM_BUDGET = "custom-budget"
const EXECUTION_PRESETS = [
  { tokens: 16_384, key: "settings.strict.budget.tight" },
  { tokens: 24_576, key: "settings.strict.budget.standard" },
  { tokens: 49_152, key: "settings.strict.budget.roomy" },
] as const
const REASONING_PRESETS = [
  { tokens: 0, key: "settings.strict.budget.off" },
  { tokens: 24_576, key: "settings.strict.budget.standard" },
  { tokens: 49_152, key: "settings.strict.budget.roomy" },
] as const
type BudgetPreset = { readonly tokens: number; readonly key: TranslationKey }

/**
 * One control for both budgets: a named preset when the stored value IS one, the number box
 * otherwise. A value the presets do not cover keeps the box — a picker that silently rounded
 * someone's tuned 30 000 to "Standard" would change a setting while claiming to display it.
 */
const BudgetControl: Component<{
  presets: readonly BudgetPreset[]
  value: number | undefined
  /**
   * What an EMPTY setting actually means, which differs per budget and is stated in each row's own
   * copy: execution says "Empty = 24576", reasoning says "Empty or 0 = off". Without this, unset
   * read as 0, matched no execution preset, and dropped that row to the number box — showing a
   * raw 24576 placeholder for a value the product would describe as Standard.
   */
  unsetTokens: number
  fallbackPlaceholder: string
  label: string
  action: string
  onPersist: (value: number) => void
}> = (props) => {
  const language = useLanguage()
  const [custom, setCustom] = createSignal(false)
  const stored = () => props.value ?? props.unsetTokens
  const isPreset = () => props.presets.some((preset) => preset.tokens === stored())
  const options = () => [
    ...props.presets.map((preset) => ({
      value: String(preset.tokens),
      label: `${language.t(preset.key)} (${preset.tokens.toLocaleString()})`,
    })),
    { value: CUSTOM_BUDGET, label: language.t("settings.strict.budget.custom") },
  ]
  return (
    <div class="w-full sm:w-[200px]">
      <Show
        when={!custom() && isPreset()}
        fallback={
          // Swept with the two rows below. `Math.min(parsed, MAX_TOKENS)` was the same silent
          // coercion: a budget typed above the ceiling was stored as the ceiling and reported as the
          // user's own choice. It is refused by name now, and 0 stays legal here because "0 = off"
          // is what this row's copy promises.
          <SettingsNumberFieldV2
            value={() => props.value}
            onCommit={(tokens) => props.onPersist(tokens)}
            onClear={() => props.onPersist(0)}
            min={0}
            max={MAX_TOKENS}
            step={1024}
            placeholder={props.fallbackPlaceholder}
            ariaLabel={props.label}
          />
        }
      >
        <SelectV2
          appearance="inline"
          data-action={props.action}
          options={options()}
          current={options().find((o) => o.value === String(stored()))}
          placement="bottom-end"
          gutter={6}
          value={(o) => o.value}
          label={(o) => o.label}
          onSelect={(option) => {
            if (!option) return
            if (option.value === CUSTOM_BUDGET) return setCustom(true)
            props.onPersist(Number(option.value))
          }}
        />
      </Show>
    </div>
  )
}
// The lever groups all default ON inside the engine — the switches show that default until overridden.
const GROUPS = ["verification", "recovery", "editingAids", "budgetSteering"] as const

export const SettingsStrictV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const current = (): StrictConfig => (serverSync().data.config as { strict?: StrictConfig }).strict ?? {}

  const persist = <K extends keyof StrictConfig>(key: K, value: Required<StrictConfig>[K]) => {
    return reportedWrite(
      () => serverSync().updateConfig({ strict: { [key]: value } } as never),
      (error) => showToast({ variant: "error", title: language.t("settings.strict.toast.failed"), description: error }),
    )
  }
  const clear = (key: keyof StrictConfig) =>
    reportedWrite(
      () => serverSync().removeConfig([["strict", key]]),
      (error) => showToast({ variant: "error", title: language.t("settings.strict.toast.failed"), description: error }),
    )

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.strict.title")}</h2>
        <p class="settings-v2-tab-description">
          {language.t("settings.strict.description")}
          <SettingsExplainV2 label={language.t("settings.strict.title")}>
            {language.t("settings.strict.description.more")}
          </SettingsExplainV2>
        </p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.strict.row.enabled.title")}
              description={
                <>
                  {language.t("settings.strict.row.enabled.description")}
                  <SettingsExplainV2 label={language.t("settings.strict.row.enabled.title")}>
                    {language.t("settings.strict.row.enabled.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <Switch
                checked={current().enabled === true}
                onChange={(checked) => void persist("enabled", checked)}
                hideLabel
              >
                {language.t("settings.strict.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            {GROUPS.map((group) => (
              <SettingsRowV2
                title={language.t(`settings.strict.row.${group}.title`)}
                description={language.t(`settings.strict.row.${group}.description`)}
              >
                <Switch
                  checked={current()[group] !== false}
                  onChange={(checked) => void persist(group, checked)}
                  hideLabel
                >
                  {language.t(`settings.strict.row.${group}.title`)}
                </Switch>
              </SettingsRowV2>
            ))}

            <SettingsRowV2
              title={language.t("settings.strict.row.attempts.title")}
              description={
                <>
                  {language.t("settings.strict.row.attempts.description")}
                  <SettingsExplainV2 label={language.t("settings.strict.row.attempts.title")}>
                    {language.t("settings.strict.row.attempts.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              {/* The row's own copy says "Empty or 1 = off", and until this box shared the settings
                  number field it made that sentence false: the handler read `parsed > 1`, one keystroke
                  away from the `min="1"` printed on the same element, so typing the documented `1`
                  stored `0` — a value the schema never describes — and `attempts || ""` then blanked
                  the field the user had just filled in. Empty now CLEARS the key (the idiom the group
                  switches above use), and 1 stores 1. */}
              <div class="w-full sm:w-[100px]">
                <SettingsNumberFieldV2
                  value={() => current().attempts || undefined}
                  onCommit={(attempts) => void persist("attempts", attempts)}
                  onClear={() => void clear("attempts")}
                  min={1}
                  max={8}
                  placeholder="1"
                  ariaLabel={language.t("settings.strict.row.attempts.title")}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.strict.row.wallMinutes.title")}
              description={language.t("settings.strict.row.wallMinutes.description")}
            >
              {/* Swept with the row above, and it was the mirror defect: `parsed > 0` with no upper
                  bound at all, so the `max="480"` on the element was decoration and a typed 5000
                  persisted silently. The shared field refuses it and says the range. */}
              <div class="w-full sm:w-[100px]">
                <SettingsNumberFieldV2
                  value={() => current().wallMinutes || undefined}
                  onCommit={(wallMinutes) => void persist("wallMinutes", wallMinutes)}
                  onClear={() => void clear("wallMinutes")}
                  min={1}
                  max={480}
                  placeholder={String(DEFAULT_WALL_MINUTES)}
                  ariaLabel={language.t("settings.strict.row.wallMinutes.title")}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.strict.row.executionTokens.title")}
              description={
                <>
                  {language.t("settings.strict.row.executionTokens.description")}
                  <SettingsExplainV2 label={language.t("settings.strict.row.executionTokens.title")}>
                    {language.t("settings.strict.row.executionTokens.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <BudgetControl
                presets={EXECUTION_PRESETS}
                value={current().executionTokens}
                unsetTokens={DEFAULT_EXECUTION_TOKENS}
                fallbackPlaceholder={String(DEFAULT_EXECUTION_TOKENS)}
                label={language.t("settings.strict.row.executionTokens.title")}
                action="settings-strict-execution-budget"
                onPersist={(value) => void persist("executionTokens", value)}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.strict.row.reasoningTokens.title")}
              description={
                <>
                  {language.t("settings.strict.row.reasoningTokens.description")}
                  <SettingsExplainV2 label={language.t("settings.strict.row.reasoningTokens.title")}>
                    {language.t("settings.strict.row.reasoningTokens.description.more")}
                  </SettingsExplainV2>
                </>
              }
            >
              <BudgetControl
                presets={REASONING_PRESETS}
                value={current().reasoningTokens}
                unsetTokens={0}
                fallbackPlaceholder="0"
                label={language.t("settings.strict.row.reasoningTokens.title")}
                action="settings-strict-reasoning-budget"
                onPersist={(value) => void persist("reasoningTokens", value)}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
