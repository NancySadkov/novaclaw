import { type ComponentProps, Show, splitProps } from "solid-js"
import { Icon } from "./icon"
import { useControlLabel } from "./control-label"

export interface TextInputV2Props extends Omit<ComponentProps<"input">, "type"> {
  /** Show the trailing copy action. */
  showCopyButton?: boolean
  /** Accessible label for the copy button. */
  copyLabel?: string
  onCopyClick?: (event: MouseEvent) => void
  /** Apply tabular numerals to the field value. */
  numeric?: boolean
  /** Error styling for the field and value text. */
  invalid?: boolean
  /** `base` is 28px tall; `large` is 32px tall. */
  appearance?: "base" | "large"
  type?: ComponentProps<"input">["type"]
}

export function TextInputV2(props: TextInputV2Props) {
  const labelId = useControlLabel()
  const [local, inputProps] = splitProps(props, [
    "class",
    "classList",
    "showCopyButton",
    "copyLabel",
    "onCopyClick",
    "numeric",
    "invalid",
    "appearance",
    "disabled",
  ])

  return (
    <div
      data-component="text-input-v2"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      data-numeric={local.numeric ? "" : undefined}
      data-appearance={local.appearance ?? "base"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <div data-slot="text-input-v2-value">
        <input
          {...inputProps}
          aria-labelledby={inputProps["aria-labelledby"] ?? (inputProps["aria-label"] ? undefined : labelId)}
          type={inputProps.type ?? "text"}
          disabled={local.disabled}
          aria-invalid={local.invalid ? true : undefined}
          data-slot="text-input-v2-input"
        />
      </div>
      <Show when={local.showCopyButton}>
        <button
          type="button"
          data-slot="text-input-v2-icon-button"
          aria-label={local.copyLabel ?? "Copy"}
          disabled={local.disabled}
          onClick={local.onCopyClick}
        >
          <Icon name="copy" />
        </button>
      </Show>
    </div>
  )
}
