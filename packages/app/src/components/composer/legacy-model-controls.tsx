import { Show, type JSX } from "solid-js"
import { Button } from "@novaclaw/ui/button"
import { Icon } from "@novaclaw/ui/icon"
import { ProviderIcon } from "@novaclaw/ui/provider-icon"
import { Select } from "@novaclaw/ui/select"
import { TooltipKeybind } from "@novaclaw/ui/tooltip"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import type { useLocal } from "@/context/local"

export type ComposerLegacyModelControlsState = {
  model: ReturnType<typeof useLocal>["model"]
  shouldAnimate: boolean
  showVariant: boolean
  variants: string[]
  style: JSX.CSSProperties | undefined
  onDone: () => void
}

/**
 * The LEGACY (pre-v2 layout) composer's model picker + variant Select, adjacent under the
 * shell-mode tray. Dies with the legacy layout — the v2 composer renders ComposerModelControl
 * and ComposerVariantControl instead.
 */
export function ComposerLegacyModelControls(props: { state: ComposerLegacyModelControlsState }) {
  const language = useLanguage()
  const command = useCommand()
  return (
    <>
      <div
        data-component="prompt-model-control"
        classList={{ "animate-in fade-in duration-300": props.state.shouldAnimate }}
      >
        {/* One local-first picker for everyone — the paid/unpaid split (branded
            cloud catalog vs "free models") was opencode residue. */}
        <TooltipKeybind
          placement="top"
          gutter={4}
          title={language.t("command.model.choose")}
          keybind={command.keybind("model.choose")}
        >
          <ModelSelectorPopover
            model={props.state.model}
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: props.state.style,
              class: "min-w-0 max-w-[320px] text-13-regular text-text-base group",
              "data-action": "prompt-model",
            }}
            onClose={props.state.onDone}
          >
            <Show when={props.state.model.current()?.provider?.id}>
              <ProviderIcon
                id={props.state.model.current()?.provider?.id ?? ""}
                class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                style={{ "will-change": "opacity", transform: "translateZ(0)" }}
              />
            </Show>
            <span class="truncate">
              {props.state.model.current()?.name ?? language.t("dialog.model.select.title")}
            </span>
            <Icon name="chevron-down" size="small" class="shrink-0" />
          </ModelSelectorPopover>
        </TooltipKeybind>
      </div>
      <Show when={props.state.showVariant}>
        <div
          data-component="prompt-variant-control"
          classList={{ "animate-in fade-in duration-300": props.state.shouldAnimate }}
        >
          <TooltipKeybind
            placement="top"
            gutter={4}
            title={language.t("command.model.variant.cycle")}
            keybind={command.keybind("model.variant.cycle")}
          >
            <Select
              size="normal"
              options={props.state.variants}
              current={props.state.model.variant.current() ?? "default"}
              label={(x) => (x === "default" ? language.t("common.default") : x)}
              onSelect={(value) => {
                props.state.model.variant.set(value === "default" ? undefined : value)
                props.state.onDone()
              }}
              class="capitalize max-w-[160px] text-text-base"
              valueClass="truncate text-13-regular text-text-base"
              triggerStyle={props.state.style}
              triggerProps={{ "data-action": "prompt-model-variant" }}
              variant="ghost"
            />
          </TooltipKeybind>
        </div>
      </Show>
    </>
  )
}
