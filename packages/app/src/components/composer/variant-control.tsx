import type { JSX } from "solid-js"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
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
        {/* `inline` is the v2 scale's chrome-less trigger — transparent, hover-overlay, fit-content —
            which is what v1's `variant="ghost"` was reaching for through a Button. Its 24px is
            overridden by the composer's own `control()` style (28px), the SAME height every other chip
            on this row states; the row's height is the row's decision, not this widget's default. The
            type utilities v1 carried here (13px/440) are dropped: select-v2.css already declares
            exactly that, and re-stating a scale in a call site is how the scale stops being one. */}
        <SelectV2
          appearance="inline"
          options={props.state.variants}
          current={props.state.current ?? "default"}
          label={(x) => (x === "default" ? language.t("common.default") : x)}
          onOpenChange={props.state.onOpenChange}
          onSelect={(value) => props.state.set(!value || value === "default" ? undefined : value)}
          class="capitalize max-w-[160px]"
          valueClass="text-v2-text-text-faint"
          style={props.state.style}
          data-action="prompt-model-variant"
        />
      </TooltipV2>
    </div>
  )
}
