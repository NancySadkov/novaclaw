import { Show, type Component, type JSX } from "solid-js"
import { useExpertise } from "@/context/expertise"
import type { ExpertiseLevel } from "@/context/settings"
import "../settings-v2.css"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  description: string | JSX.Element
  /** Hide this row below the given expertise level (uix.md §6.3 declarative gating). */
  minLevel?: ExpertiseLevel
  children: JSX.Element
}

export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  const { atLeast } = useExpertise()
  return (
    <Show when={!props.minLevel || atLeast(props.minLevel)}>
      <div data-component="settings-v2-row">
        <div data-slot="settings-v2-row-copy">
          <div data-slot="settings-v2-row-title">{props.title}</div>
          <div data-slot="settings-v2-row-description">{props.description}</div>
        </div>
        <div data-slot="settings-v2-row-control">{props.children}</div>
      </div>
    </Show>
  )
}
