import { Show, type JSX } from "solid-js"
import { Button } from "@novaclaw/ui/button"
import { Icon } from "@novaclaw/ui/icon"
import { KeybindV2 } from "@novaclaw/ui/v2/keybind-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import type { useLocal } from "@/context/local"

export type ComposerModelControlState = {
  loading: boolean
  shouldAnimate: boolean
  title: string
  keybind: string[]
  model: ReturnType<typeof useLocal>["model"]
  providerID?: string
  modelName: string
  style: JSX.CSSProperties | undefined
  onClose: () => void
}

export function ComposerModelControl(props: { state: ComposerModelControlState }) {
  return (
    <Show when={!props.state.loading}>
      <TooltipV2
        placement="top"
        gutter={4}
        value={
          <>
            {props.state.title}
            <KeybindV2 keys={props.state.keybind} variant="neutral" />
          </>
        }
      >
        <ModelSelectorPopover
          model={props.state.model}
          triggerAs={Button}
          triggerProps={{
            variant: "ghost",
            size: "normal",
            style: props.state.style,
            // Narrower cap than before (no provider icon prefix either): the full name is one
            // tap away in the picker, so the chip stays compact and phone-friendly.
            class:
              "min-w-0 max-w-[130px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group",
            classList: { "animate-in fade-in": props.state.shouldAnimate },
            "data-action": "prompt-model",
          }}
          onClose={props.state.onClose}
        >
          <span class="truncate">{props.state.modelName}</span>
          <span class="-ml-1 shrink-0 flex size-fit">
            <Icon name="chevron-down" size="small" class="text-v2-icon-icon-muted" />
          </span>
        </ModelSelectorPopover>
      </TooltipV2>
    </Show>
  )
}
