import { Show, type Component, type JSX } from "solid-js"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useExpertise } from "@/context/expertise"
import type { ExpertiseLevel } from "@/context/settings"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  description: string | JSX.Element
  /**
   * Extra detail that pops as a tooltip when the row's copy is hovered or focused (owner,
   * 2026-08-13: indicator rows stay scannable; the explanation is on demand, not always on).
   */
  hint?: JSX.Element
  /** Hide this row below the given expertise level (uix.md §6.3 declarative gating). */
  minLevel?: ExpertiseLevel
  children: JSX.Element
}

export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  const { atLeast } = useExpertise()
  // A function, not a shared element: each branch of the Show needs its own DOM nodes.
  const copy = () => (
    <>
      <div data-slot="settings-v2-row-title">{props.title}</div>
      <div data-slot="settings-v2-row-description">{props.description}</div>
    </>
  )
  return (
    <Show when={!props.minLevel || atLeast(props.minLevel)}>
      <div data-component="settings-v2-row">
        <div data-slot="settings-v2-row-copy">
          <Show when={props.hint} fallback={copy()}>
            {/* The trigger div sits between row-copy and its children, so it restates the copy
                stack (column + 8px gap); the content style is inline because tooltip-v2.css is
                unlayered and would beat any utility class (line-height 12px on one long line). */}
            <TooltipV2
              value={props.hint}
              placement="top-start"
              class="min-w-0 flex-col gap-2 cursor-help"
              contentStyle={{ "max-width": "300px", "line-height": "1.45", "white-space": "normal" }}
            >
              {copy()}
            </TooltipV2>
          </Show>
        </div>
        <div data-slot="settings-v2-row-control">{props.children}</div>
      </div>
    </Show>
  )
}
