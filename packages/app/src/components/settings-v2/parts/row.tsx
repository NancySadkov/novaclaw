import { Show, createUniqueId, type Component, type JSX } from "solid-js"
import { ControlLabelContext } from "@novaclaw/ui/v2/control-label"
import { useExpertise } from "@/context/expertise"
import type { ExpertiseLevel } from "@/context/settings"
import { SettingsExplainV2 } from "../explain"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  /**
   * The short line that states what is in force RIGHT NOW (uix.md §1.4, AGENTS.md 12d). Optional:
   * a row whose whole explanation fits behind `info` has none, and that is the preferred shape when
   * the sentence would only repeat the title.
   */
  description?: string | JSX.Element
  /**
   * The on-demand explanation — the paragraph that teaches WHY. Rendered as a `?` circle immediately
   * RIGHT OF THE TITLE (owner, 2026-09-16: *"these (?) circles are placed right of the variable name,
   * instead of the next line"*), because a disclosure on its own line below competes with the control
   * for the same space and reads as more copy to skip.
   *
   * ⚠️ Putting the existing `desc.more` text here is the whole port: where a row had a `description`
   * plus a separate `SettingsExplainV2`, the two merge and the inline paragraph goes away.
   */
  info?: JSX.Element
  // ⚠️ No `hint` (2026-09-03). It wrapped the copy in a hover-only tooltip on a plain div —
  // no `tabindex`, no press affordance — so the sentence saying what restoring an identity backup
  // COSTS did not exist by keyboard or on a phone. On-demand detail goes in `info`, which is
  // focus-reachable and now also tap-reachable (uix.md §1.4).
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
        <Show when={props.info}>
          <SettingsExplainV2 label={typeof props.title === "string" ? props.title : titleId}>
            {props.info}
          </SettingsExplainV2>
        </Show>
      </div>
      <Show when={props.description !== undefined}>
        <div data-slot="settings-v2-row-description">{props.description}</div>
      </Show>
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
