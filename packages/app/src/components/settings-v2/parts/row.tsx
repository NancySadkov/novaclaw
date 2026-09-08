import { Show, createUniqueId, type Component, type JSX } from "solid-js"
import { ControlLabelContext } from "@novaclaw/ui/v2/control-label"
import { useExpertise } from "@/context/expertise"
import type { ExpertiseLevel } from "@/context/settings"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  description: string | JSX.Element
  // ⚠️ No `hint` (2026-09-03). It wrapped the copy in a hover-only tooltip on a plain div —
  // no `tabindex`, no press affordance — so the sentence saying what restoring an identity backup
  // COSTS did not exist by keyboard or on a phone. On-demand detail goes in `description` as a
  // `SettingsExplainV2`, which is at least focus-reachable (uix.md §1.4).
  /** Hide this row below the given expertise level (uix.md §6.3 declarative gating). */
  minLevel?: ExpertiseLevel
  children: JSX.Element
}

export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  const { atLeast } = useExpertise()
  const titleId = createUniqueId()
  // A function, not a shared element: each branch of the Show needs its own DOM nodes.
  const copy = () => (
    <>
      <div id={titleId} data-slot="settings-v2-row-title">
        {props.title}
      </div>
      <div data-slot="settings-v2-row-description">{props.description}</div>
    </>
  )
  return (
    <Show when={!props.minLevel || atLeast(props.minLevel)}>
      <div data-component="settings-v2-row">
        <div data-slot="settings-v2-row-copy">{copy()}</div>
        <div data-slot="settings-v2-row-control">
          <ControlLabelContext.Provider value={titleId}>{props.children}</ControlLabelContext.Provider>
        </div>
      </div>
    </Show>
  )
}
