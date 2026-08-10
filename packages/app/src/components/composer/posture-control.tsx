import type { JSX } from "solid-js"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"

export type ComposerPosture = "chat" | "agent"

export type ComposerPostureControlState = {
  current: ComposerPosture
  style: JSX.CSSProperties | undefined
  onSelect: (posture: ComposerPosture) => void
}

const POSTURES: ComposerPosture[] = ["chat", "agent"]

/** The primary latency/authority choice. Internally this is the sparse `shortChat` session feature;
 * the user sees the product distinction, not an implementation toggle. */
export function ComposerPostureControl(props: { state: ComposerPostureControlState }) {
  const language = useLanguage()
  return (
    <TooltipV2 placement="top" gutter={4} value={language.t(`prompt.posture.${props.state.current}.description`)}>
      <SelectV2
        appearance="inline"
        options={POSTURES}
        current={props.state.current}
        label={(posture) => language.t(`prompt.posture.${posture}.title`)}
        onSelect={(posture) => {
          if (posture && posture !== props.state.current) props.state.onSelect(posture)
        }}
        class="max-w-[150px]"
        valueClass="text-v2-text-text-base"
        style={props.state.style}
        data-action="prompt-posture"
      />
    </TooltipV2>
  )
}
