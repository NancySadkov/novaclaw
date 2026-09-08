import { Show, createSignal } from "solid-js"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"

/**
 * The settings number box: **it commits on `change`, and it never coerces what you typed.**
 *
 * 🔴 **Why it exists as a component rather than as advice.** The class it closes is *a control that
 * writes on every keystroke, coercing the in-progress value* — so the intermediate state a user must
 * pass THROUGH to reach a legal one is clamped away and written back into the box. Measured on the
 * Tunes tab: to set the reminder budget (`min` 64) to 512 you type `5`, `Math.max(64, 5)` writes
 * **64** to the instance config, the echoed store rewrites the box to `64`, and the next keystroke
 * appends — `641`. No keystroke sequence reaches 512, and every character on the way costs a config
 * PATCH, a bootstrap refetch and two global query invalidations. The same class, one file over, made
 * Strict's "Attempts" store `0` when the user typed the `1` its own copy documents.
 *
 * The two halves of the fix are both structural, and neither is reachable from a call site:
 *
 * 1. **There is no per-keystroke path.** The only handler is `onChange` — blur or Enter. A caller
 *    cannot opt back into `input`, because no prop offers it. (`parts/preset-field.tsx` still takes
 *    a `commit` prop because ITS other caller writes to a local form store; a settings row always
 *    writes to the network, so the choice does not exist here.)
 * 2. **An out-of-range value is REFUSED, visibly, and not written.** Clamping is the quiet form of
 *    the same defect: it stores a number the user did not choose and reports success. `min`/`max`
 *    are declared once and used for the HTML attributes AND the check, so the box and the handler
 *    cannot disagree the way `min="1"` beside `parsed > 1` did.
 *
 * Whole numbers are the default. A duration may explicitly allow decimals; it still gets the same
 * commit boundary and visible range refusal instead of rebuilding a raw number input.
 */
export interface SettingsNumberFieldProps {
  /** The stored value, reactive. `undefined` shows the placeholder — the row is on its default. */
  readonly value: () => number | undefined
  /** An in-range whole number the user committed. Never fires for a value equal to the stored one. */
  readonly onCommit: (next: number) => void
  /**
   * The box was emptied. Omit when the row has no "unset" state: the box then restores the stored
   * value rather than leaving an empty field that claims a setting nobody chose.
   */
  readonly onClear?: () => void
  readonly min: number
  readonly max: number
  readonly step?: number
  /** Opt in only for a value whose displayed human unit is legitimately fractional. */
  readonly allowDecimal?: boolean
  readonly placeholder?: string
  readonly ariaLabel: string
  /** A unit shown beside the box (`msg`, `tok`, `%`) — decoration, so it is hidden from screen readers. */
  readonly unit?: string
  /** Sizing for the box row. The refusal message is placed under it either way. */
  readonly class?: string
}

export function parseSettingsNumber(
  raw: string,
  range: { min: number; max: number; allowDecimal?: boolean },
): number | undefined {
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed)) return undefined
  if (!range.allowDecimal && !Number.isInteger(parsed)) return undefined
  if (parsed < range.min || parsed > range.max) return undefined
  return parsed
}

export function SettingsNumberFieldV2(props: SettingsNumberFieldProps) {
  const language = useLanguage()
  const [refused, setRefused] = createSignal(false)

  const text = () => {
    const value = props.value()
    return value === undefined ? "" : String(value)
  }

  const commit = (input: HTMLInputElement) => {
    const typed = input.value.trim()
    if (typed === "") {
      setRefused(false)
      if (props.onClear) props.onClear()
      // No "unset" state on this row, so the box goes back to what is actually in force. Leaving it
      // blank would state a value the config does not hold.
      else input.value = text()
      return
    }
    const parsed = parseSettingsNumber(typed, props)
    if (parsed === undefined) {
      setRefused(true)
      return
    }
    setRefused(false)
    // A commit of the value already stored is not an edit. The guard matters because this handler
    // also fires when a programmatic value change is followed by a blur.
    if (parsed !== props.value()) props.onCommit(parsed)
  }

  return (
    <div class="flex flex-col gap-1">
      <div class={props.class}>
        <TextInputV2
          type="number"
          appearance="base"
          min={String(props.min)}
          max={String(props.max)}
          step={String(props.step ?? 1)}
          value={text()}
          placeholder={props.placeholder}
          invalid={refused()}
          aria-label={props.ariaLabel}
          // Focus clears the refusal (the user is on their way to fixing it) and selects the whole
          // value, so typing REPLACES the current setting instead of inserting into it — the defect
          // `parts/preset-field.tsx` documents, where a field holding `32768` clicked and typed
          // `8192` became `327819268`.
          onFocus={(event) => {
            setRefused(false)
            event.currentTarget.select?.()
          }}
          onChange={(event) => commit(event.currentTarget)}
        />
        <Show when={props.unit}>{(unit) => <span aria-hidden="true">{unit()}</span>}</Show>
      </div>
      <Show when={refused()}>
        <span
          role="alert"
          data-slot="settings-v2-number-refused"
          class="text-[11px] leading-tight text-v2-state-fg-danger"
        >
          {language.t(props.allowDecimal ? "settings.field.number.rangeDecimal" : "settings.field.number.range", {
            min: props.min,
            max: props.max,
          })}
        </span>
      </Show>
    </div>
  )
}
