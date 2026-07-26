import { Component, Show, type ComponentProps } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import type { HomeApp } from "@/apps/registry"

// One home-screen app tile: a large rounded gradient icon square + a label. Tap → app.open().
// Two shapes share one visual language:
//   • regular tile — 5rem gradient square, 40px white glyph, 13px label
//   • hero tile (app.hero) — a 2×2 grid-span card with a 56px glyph, title + subtitle; the single
//     eye-anchor of the home screen (Chats).
// The gradient derives from the app's accent hue; a top inner highlight + accent glow on hover give
// the glassmorphic depth. `--icon-base` is overridden to white because the themed default (lavender)
// washes out on saturated tiles.

const tileStyle = (app: HomeApp) => ({
  "background-image": `linear-gradient(155deg, color-mix(in oklab, ${app.accent} 88%, white) -8%, ${app.accent} 42%, color-mix(in oklab, ${app.accent} 58%, black) 105%)`,
  "--icon-base":
    app.glyphTone === "dark" ? "color-mix(in srgb, var(--nc-ink, #1a1135) 92%, transparent)" : "rgba(255,255,255,0.96)",
  "--tile-glow": `color-mix(in oklab, ${app.accent} 55%, transparent)`,
})

// `shouldSuppressOpen` lets the home screen swallow the trailing click that a pointer emits when a
// drag-to-reorder is released over the tile — otherwise reordering an app would also open it.
export const AppTile: Component<{ app: HomeApp; shouldSuppressOpen?: () => boolean }> = (props) => (
  <Show when={props.app.hero} fallback={<RegularTile app={props.app} shouldSuppressOpen={props.shouldSuppressOpen} />}>
    <HeroTile app={props.app} shouldSuppressOpen={props.shouldSuppressOpen} />
  </Show>
)

const openUnlessDragged = (props: { app: HomeApp; shouldSuppressOpen?: () => boolean }) => {
  if (props.shouldSuppressOpen?.()) return
  props.app.open()
}

// The iOS-vocabulary attention badge (uix-improvement slice 2): a count pill on the tile corner when
// the app's reactive `badge()` accessor reports > 0 (e.g. Chats waiting on the user). Read here — not
// in the apps memo — so a count change re-renders only the badge, never the launcher grid.
const TileBadge: Component<{ app: HomeApp }> = (props) => {
  const count = () => props.app.badge?.() ?? 0
  return (
    <Show when={count() > 0}>
      <span
        data-slot="app-tile-badge"
        class="pointer-events-none absolute -right-1.5 -top-1.5 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-v2-state-fg-danger px-1.5 text-[11px] font-semibold leading-none text-white shadow-[0_1px_4px_rgba(0,0,0,0.35)]"
      >
        {count() > 9 ? "9+" : count()}
      </span>
    </Show>
  )
}

const RegularTile: Component<{ app: HomeApp; shouldSuppressOpen?: () => boolean }> = (props) => (
  <button
    type="button"
    class="group flex flex-col items-center gap-2.5 w-full max-w-[5rem] select-none focus:outline-none"
    onClick={() => openUnlessDragged(props)}
    aria-label={props.app.title}
    title={props.app.subtitle}
  >
    {/* w-full + aspect-square (not a fixed size) so the square shrinks with its grid track on
        phone widths instead of overflowing the viewport. */}
    <div
      class="relative flex items-center justify-center w-full aspect-square rounded-[1.375rem] shadow-[var(--v2-elevation-floating)] ring-1 ring-white/15 transition-all duration-150 group-hover:-translate-y-1 group-hover:shadow-[0_10px_28px_var(--tile-glow),var(--v2-elevation-floating)] group-active:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-[var(--v2-border-border-focus)] after:absolute after:inset-0 after:rounded-[inherit] after:bg-gradient-to-b after:from-white/20 after:via-white/0 after:to-black/10 after:pointer-events-none"
      style={tileStyle(props.app)}
    >
      <Icon name={props.app.icon as ComponentProps<typeof Icon>["name"]} size="2xl" />
      <TileBadge app={props.app} />
    </div>
    <span class="text-[13px] font-medium leading-tight text-v2-text-text-base/90 truncate max-w-full text-center [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
      {props.app.title}
    </span>
  </button>
)

const HeroTile: Component<{ app: HomeApp; shouldSuppressOpen?: () => boolean }> = (props) => (
  <button
    type="button"
    class="group flex flex-col w-full h-full select-none focus:outline-none"
    onClick={() => openUnlessDragged(props)}
    aria-label={props.app.title}
  >
    {/* The grid span (col-span/row-span) lives on the SortableTile wrapper — this inner button just
        fills it (w-full h-full). Don't re-declare the span here (dead classes — L7). */}
    <div
      class="relative flex flex-col items-start justify-between w-full h-full min-h-[11.5rem] rounded-[1.75rem] p-6 shadow-[var(--v2-elevation-floating)] ring-1 ring-white/20 transition-all duration-150 group-hover:-translate-y-1 group-hover:shadow-[0_14px_40px_var(--tile-glow),var(--v2-elevation-floating)] group-active:scale-[0.98] group-focus-visible:ring-2 group-focus-visible:ring-[var(--v2-border-border-focus)] after:absolute after:inset-0 after:rounded-[inherit] after:bg-gradient-to-b after:from-white/25 after:via-white/0 after:to-black/10 after:pointer-events-none"
      style={tileStyle(props.app)}
    >
      <Icon name={props.app.icon as ComponentProps<typeof Icon>["name"]} size="3xl" />
      <TileBadge app={props.app} />
      <div
        class="flex flex-col items-start gap-1 text-left"
        style={{ color: props.app.glyphTone === "dark" ? "color-mix(in srgb, var(--nc-ink, #1a1135) 94%, transparent)" : "#ffffff" }}
      >
        <span class="text-[19px] font-semibold leading-tight [text-shadow:0_1px_2px_rgba(255,255,255,0.12)]">{props.app.title}</span>
        {/* Live status wins over the tagline: while agents are running, what they are DOING is the most
            useful thing this tile can say. Falls back to the subtitle when there is nothing to report. */}
        <Show when={props.app.status?.() ?? props.app.subtitle}>
          {(line) => <span class="text-[13px] font-medium leading-snug opacity-85">{line()}</span>}
        </Show>
      </div>
    </div>
  </button>
)
