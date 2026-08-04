import type { JSX } from "solid-js"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"

export type ComposerFolderControlState = {
  name: string
  working: boolean
  style: JSX.CSSProperties | undefined
  pick: () => void
}

/**
 * The chat's working-folder chip (mid-session): click to MIGRATE the session to another folder
 * (control-plane move — the chat, its config, and future file work re-home there). Disabled while
 * the agent is working; a mid-turn move would yank the cwd out from under running tools.
 */
export function ComposerFolderControl(props: { state: ComposerFolderControlState }) {
  const language = useLanguage()
  return (
    <TooltipV2
      placement="top"
      gutter={4}
      value={language.t(props.state.working ? "prompt.folder.tooltip.working" : "prompt.folder.tooltip")}
    >
      <button
        type="button"
        data-action="prompt-folder"
        disabled={props.state.working}
        class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-5 text-v2-text-text-faint hover:bg-v2-background-bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        style={props.state.style}
        onClick={() => props.state.pick()}
      >
        <span class="max-w-[10rem] truncate">{props.state.name}</span>
      </button>
    </TooltipV2>
  )
}
