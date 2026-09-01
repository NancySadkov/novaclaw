import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { PRESETS, optId, optLabel, numFromText, type FieldKey, type Opt } from "./preset-value"

/**
 * The named-preset numeric control: a droplist of typical values by name beside a raw box that still
 * allows any exact value. The table and the pure functions behind it live in `preset-value.ts`; this
 * file is only the view, so that half stays testable without a DOM.
 *
 * ⚠️ **The caller owns storage, and that is the whole point of the seam.** The model
 * dialog stores into a Solid form store; the Affective settings tab stores into instance config,
 * where clearing the field is a DELETE (`v2.config.remove`) rather than a written `0`. A component
 * that persisted on its callers' behalf could not serve both without knowing which it was talking to.
 */
export interface PresetFieldProps {
  /** Which preset list to offer, and which value shape the caller is editing. */
  readonly field: FieldKey
  /** The current raw text. A getter, not a value: the caller's source is reactive. */
  readonly value: () => string
  /** Raw text back. `""` means "cleared" — what THAT means on the wire is the caller's decision. */
  readonly onValue: (next: string) => void
  /** Named by the caller: the two callers live under different i18n namespaces. */
  readonly ariaLabel: string
  /**
   * When the RAW BOX reports a value. The droplist is unaffected — picking from a list IS the
   * commit, so it always fires immediately.
   *
   * 🔴 **`"change"` exists because `"input"` is a network write per KEYSTROKE for a caller that
   * persists remotely.** Measured live on the Affective tab, 2026-09-01: typing `0.9` one character
   * at a time sent **six `PATCH /global/config` requests** (plus six refetches) and, on the way,
   * stored the intermediate `0` — which is now a REAL temperature rather than the old "cleared"
   * sentinel, so the halfway state is a setting the user never chose. Clearing the box character by
   * character is worse: it fires a config DELETE mid-word.
   *
   * `"input"` (the default) is right for the model dialog, whose `onValue` writes to a local form
   * store and only reaches the server on Save. Default to the caller's storage, not to a habit.
   */
  readonly commit?: "input" | "change"
}

// A named-preset droplist + a raw input for one numeric field. The droplist teaches typical values
// by name; the input allows any exact value and reflects back as "Custom" when it matches no preset.
export const PresetFieldV2 = (p: PresetFieldProps) => {
  const language = useLanguage()
  const options = createMemo<Opt[]>(() =>
    PRESETS[p.field].map((preset) => ({ id: optId(preset), num: preset.num, label: optLabel(preset, language.t) })),
  )
  const currentNum = () => numFromText(p.value())
  const matched = () => options().find((o) => o.num === currentNum())
  const customOpt = (): Opt | undefined =>
    currentNum() !== undefined && !matched()
      ? {
          id: "custom",
          num: currentNum(),
          label: `${language.t("settings.models.config.preset.custom")} (${currentNum()})`,
        }
      : undefined
  const allOptions = () => {
    const extra = customOpt()
    return extra ? [...options(), extra] : options()
  }
  const current = () => matched() ?? customOpt() ?? options()[0]
  return (
    // No disabled state here any more. It existed for ONE caller — the old budgeting switch, which greyed
    // the budget row out via `pointer-events-none`. "Disabled" is now a value in the list itself, so a row
    // that cannot be clicked is always a bug; keeping the mechanism around only preserved a way to cause it.
    <div class="flex items-center gap-2 justify-end">
      <SelectV2<Opt>
        appearance="inline"
        aria-label={p.ariaLabel}
        options={allOptions()}
        current={current()}
        value={(o) => o.id}
        label={(o) => o.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(o) => o && p.onValue(o.num === undefined ? "" : String(o.num))}
      />
      <div class="w-[76px] shrink-0">
        <TextInputV2
          type="text"
          appearance="base"
          inputmode="decimal"
          value={p.value()}
          // One handler or the other, never both — `change` also fires after a programmatic
          // `input`, so wiring both would double-write on every commit.
          onInput={(event) => (p.commit ?? "input") === "input" && p.onValue(event.currentTarget.value)}
          onChange={(event) => (p.commit ?? "input") === "change" && p.onValue(event.currentTarget.value)}
          // Select the whole value on focus so typing REPLACES it. These fields arrive pre-filled with
          // the current setting, and a click lands the caret wherever you happened to click — so
          // typing a new number silently INSERTED into the old one. Measured live: a field holding
          // `32768`, clicked and typed `8192`, became `327819268`. Nothing downstream clamps it, so
          // the garbage was persisted; the real dev DB ended up with a thinkingBudget of 600060006000
          // (6000 typed three times), which silently disables the budget it was meant to set.
          onFocus={(event) => event.currentTarget.select()}
          placeholder={language.t("settings.models.config.defaultPlaceholder")}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={p.ariaLabel}
        />
      </div>
    </div>
  )
}
