import { Show, type JSX, type ParentComponent } from "solid-js"
import { EXPERTISE_ORDER, useSettings, type ExpertiseLevel } from "@/context/settings"

// The expertise-level consumption API (uix.md §6.3). Thin — it rides SettingsProvider (client
// settings.v3 is the source of truth), so there is no new provider to wire in app.tsx. `atLeast`
// is the whole gating primitive: a surface declares the minimum level that may see it, and it is
// HIDDEN below that (progressive disclosure with consent, never a wall of greyed-out mystery).
export function useExpertise() {
  const settings = useSettings()
  const level = () => settings.general.expertiseLevel()
  const atLeast = (min: ExpertiseLevel) => EXPERTISE_ORDER[level()] >= EXPERTISE_ORDER[min]
  return {
    level,
    atLeast,
    setLevel: (value: ExpertiseLevel) => settings.general.setExpertiseLevel(value),
  }
}

// Declarative gate: render children only when the current level is at least `min`. Everything the
// vision says "hide until unlocked" wraps in this (or the `minLevel` props that self-wrap in it).
export const RequiresLevel: ParentComponent<{ min: ExpertiseLevel; fallback?: JSX.Element }> = (props) => {
  const { atLeast } = useExpertise()
  return (
    <Show when={atLeast(props.min)} fallback={props.fallback}>
      {props.children}
    </Show>
  )
}
