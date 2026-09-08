import { type ComponentProps, splitProps } from "solid-js"
import { useControlLabel } from "./control-label"

export interface TextareaV2Props extends ComponentProps<"textarea"> {
  /** Error styling for the field and value text. */
  invalid?: boolean
}

export function TextareaV2(props: TextareaV2Props) {
  const labelId = useControlLabel()
  const [local, textareaProps] = splitProps(props, ["class", "classList", "invalid", "disabled", "rows"])

  return (
    <div
      data-component="textarea-v2"
      data-disabled={local.disabled ? "" : undefined}
      data-invalid={local.invalid ? "" : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <textarea
        {...textareaProps}
        aria-labelledby={textareaProps["aria-labelledby"] ?? (textareaProps["aria-label"] ? undefined : labelId)}
        rows={local.rows ?? 3}
        disabled={local.disabled}
        aria-invalid={local.invalid ? true : undefined}
        data-slot="textarea-v2-textarea"
      />
    </div>
  )
}
