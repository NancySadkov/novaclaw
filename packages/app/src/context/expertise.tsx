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

// Permission modes escalate in danger, but only ONE of them now leaves the project folder. Since
// external writes are guarded independently of the mode (agent baseline asks; an unattended chain is
// hard-denied — config-resolve.ts §UNATTENDED CONFINEMENT), plan/ask/surgical/bypass all stay INSIDE
// the folder and are safe to offer at any level. Gating `bypass` to Developer hid the one mode most
// users actually want ("work in my project without asking me every time") and left Normal with just
// two options, which read as a broken picker.
//
// `yolo` keeps its gate: it is the mode that ALLOWS the external classes outright, i.e. the only one
// that can touch anything outside the folder. That is the `rm -rf /` shape, so it stays behind Developer.
// A stored value above the current level still renders in the picker (so it never blanks) — the honesty
// valve nudges the user to unlock and review it rather than silently hiding an active choice.
export const PERMISSION_MODE_MIN_LEVEL: Record<string, ExpertiseLevel> = {
  plan: "normal",
  ask: "normal",
  surgical: "normal",
  bypass: "normal",
  yolo: "developer",
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
