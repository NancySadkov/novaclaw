import { Switch as Kobalte } from "@kobalte/core/switch"
import { Show, splitProps } from "solid-js"
import type { ComponentProps, ParentProps } from "solid-js"
import { useControlLabel } from "./control-label"

export interface SwitchProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  hideLabel?: boolean
}

export function Switch(props: SwitchProps) {
  const label = useControlLabel()
  const [local, others] = splitProps(props, ["children", "class", "hideLabel", "aria-label", "aria-labelledby"])
  return (
    <Kobalte {...others} class={local.class} data-component="switch">
      <Kobalte.Input
        data-slot="switch-input"
        aria-label={local["aria-label"]}
        aria-labelledby={local["aria-labelledby"] ?? (local["aria-label"] || local.children ? undefined : label)}
      />
      <Show when={local.children}>
        {(label) => (
          <Kobalte.Label data-slot="switch-label" classList={{ "sr-only": local.hideLabel }}>
            {label()}
          </Kobalte.Label>
        )}
      </Show>
      <Kobalte.Control data-slot="switch-control">
        <Kobalte.Thumb data-slot="switch-thumb" />
      </Kobalte.Control>
      <Kobalte.ErrorMessage data-slot="switch-error" />
    </Kobalte>
  )
}
