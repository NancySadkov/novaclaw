import type { JSX } from "solid-js"
import { Select } from "@novaclaw/ui/select"
import { KeybindV2 } from "@novaclaw/ui/v2/keybind-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

export type ComposerVariantControlState = {
  /** Reveal only on composer hover/focus while no variant is picked and the list is closed. */
  revealOnHoverOnly: boolean
  shouldAnimate: boolean
  variants: string[]
  current: string | undefined
  style: JSX.CSSProperties | undefined
  set: (variant: string | undefined) => void
  onOpenChange: (open: boolean) => void
}

/** The model-variant cycle Select (v2 composer) — e.g. a model's thinking/effort variants. */
export function ComposerVariantControl(props: { state: ComposerVariantControlState }) {
  const language = useLanguage()
  const command = useCommand()
  return (
    <div
      data-component="prompt-variant-control"
      classList={{
        "animate-in fade-in": props.state.shouldAnimate,
        "hidden group-hover/prompt-input:block group-focus-within/prompt-input:block": props.state.revealOnHoverOnly,
      }}
    >
      <TooltipV2
        placement="top"
        gutter={4}
        value={
          <>
            {language.t("command.model.variant.cycle")}
            <KeybindV2 keys={command.keybindParts("model.variant.cycle")} variant="neutral" />
          </>
        }
      >
        <Select
          size="normal"
          options={props.state.variants}
          current={props.state.current ?? "default"}
          label={(x) => (x === "default" ? language.t("common.default") : x)}
          onOpenChange={props.state.onOpenChange}
          onSelect={(value) => props.state.set(value === "default" ? undefined : value)}
          class="capitalize max-w-[160px] justify-start text-v2-text-text-faint"
          valueClass="truncate text-[13px] font-[440] leading-5 text-v2-text-text-faint"
          triggerStyle={props.state.style}
          triggerProps={{ "data-action": "prompt-model-variant" }}
          variant="ghost"
        />
      </TooltipV2>
    </div>
  )
}
