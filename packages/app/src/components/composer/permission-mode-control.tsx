import { createMemo, type JSX } from "solid-js"
import { Select } from "@novaclaw/ui/select"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import type { PermissionMode } from "@/context/local"
import { useExpertise, PERMISSION_MODE_MIN_LEVEL } from "@/context/expertise"

export type ComposerPermissionModeControlState = {
  title: string
  current: PermissionMode
  label: (mode: PermissionMode) => string
  style: JSX.CSSProperties | undefined
  onSelect: (value: PermissionMode) => void
}

// Three postures, in escalating order: Analyze (read-only + a temp report) · Build (write this project)
// · YOLO (write the whole machine). `ask` and `surgical` are deliberately absent — surgical moved to the
// Tuning modal as "Edits instead of overwriting", and a stored value of either still renders via the
// current-value valve below, so an existing session never blanks its picker.
const PERMISSION_MODES: PermissionMode[] = ["plan", "bypass", "yolo"]

/** 1K: the create-time permission-mode droplist — mirrors ComposerAgentControl's Select styling. */
export function ComposerPermissionModeControl(props: { state: ComposerPermissionModeControlState }) {
  // uix.md §6.4: Normal sees plan/ask, Advanced +surgical, Developer +bypass/yolo. The current value
  // always stays listed so an already-set mode never vanishes from the picker.
  const { atLeast } = useExpertise()
  const options = createMemo(() =>
    PERMISSION_MODES.filter(
      (mode) => mode === props.state.current || atLeast(PERMISSION_MODE_MIN_LEVEL[mode] ?? "normal"),
    ),
  )
  return (
    <TooltipV2 placement="top" gutter={4} value={props.state.title}>
      <Select
        size="normal"
        options={options()}
        current={props.state.current}
        label={(mode) => props.state.label(mode)}
        onSelect={(value) => {
          // Kobalte re-emits onChange with the UNCHANGED value whenever the options array is
          // recreated (any composer-controls recompute) — only a real change may hit the server.
          if (value && value !== props.state.current) props.state.onSelect(value)
        }}
        class="max-w-[190px] justify-start text-v2-text-text-faint [&_[data-component=icon]]:text-v2-icon-icon-muted"
        valueClass="truncate text-[13px] font-[440] leading-5 text-v2-text-text-faint"
        triggerStyle={props.state.style}
        triggerProps={{ "data-action": "prompt-permission-mode" }}
        variant="ghost"
      />
    </TooltipV2>
  )
}
