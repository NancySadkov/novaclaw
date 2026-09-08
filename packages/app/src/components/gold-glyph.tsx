import { Component } from "solid-js"

// A UI-kit gold pictogram (plan repo doc/gfx `NOVA_Agentic_OS_UI_Kit/05_icons/glyphs/`, shipped at
// public/assets/skin/glyphs/) — the skin's chrome icon language for page headers, nav and empty
// states. Purely decorative (alt=""), so always pair it with visible text; the soft contained glow
// is the skin's "warm-gold, low radius" rule. Size via the class (default 20px).
export const GoldGlyph: Component<{ name: string; class?: string }> = (props) => (
  <img
    src={`/assets/skin/glyphs/${props.name}.png`}
    alt=""
    draggable={false}
    class={`shrink-0 select-none object-contain [filter:drop-shadow(0_0_8px_rgba(216,171,75,0.25))] ${props.class ?? "size-5"}`}
  />
)
