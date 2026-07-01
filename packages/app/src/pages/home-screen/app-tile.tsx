import { Component, type ComponentProps } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import type { HomeApp } from "@/apps/registry"

// One home-screen app tile: a large rounded gradient icon square + a label. Tap → app.open().
// The gradient is derived from the app's accent hue so tiles read distinctly even before the
// purple/gold theme lands.
export const AppTile: Component<{ app: HomeApp }> = (props) => (
  <button
    type="button"
    class="group flex flex-col items-center gap-2 w-[4.5rem] select-none focus:outline-none"
    onClick={() => props.app.open()}
    aria-label={props.app.title}
  >
    <div
      class="relative flex items-center justify-center size-[4.5rem] rounded-[1.25rem] shadow-[var(--v2-elevation-floating)] ring-1 ring-white/10 transition-transform duration-100 group-hover:-translate-y-0.5 group-active:scale-95"
      style={{ "background-image": `linear-gradient(150deg, ${props.app.accent}, color-mix(in oklab, ${props.app.accent} 62%, black))` }}
    >
      <Icon name={props.app.icon as ComponentProps<typeof Icon>["name"]} class="size-8 text-white/95" />
    </div>
    <span class="text-12-medium text-v2-text-text-base truncate max-w-full text-center">{props.app.title}</span>
  </button>
)
