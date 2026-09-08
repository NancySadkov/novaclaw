import { Component, Index, Show, type ComponentProps } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import type { HomeApp } from "@/apps/registry"

// One home-screen app tile: a large rounded icon square + a label. Tap → app.open().
// Three shapes share one visual language:
//   • artwork tile (app.tile) — finished NOVA UI-kit art (purple tile, gold frame + pictogram);
//     normally the PNG carries its own bevel, so no ring/sheen is painted over it. A transparent
//     glyph-only asset declares `tileNeedsFrame`, and this renderer supplies that same frame.
//   • gradient tile — 5rem gradient square, 40px white glyph; the fallback for contributed apps
//     without artwork. The gradient derives from the app's accent hue; a top inner highlight +
//     accent glow on hover give the glassmorphic depth. `--icon-base` is overridden to white
//     because the themed default washes out on saturated tiles.
//   • hero tile (app.hero) — a 2×2 grid-span glass panel with the NOVA brand mark centered,
//     title + subtitle below; the single eye-anchor of the home screen (Chats).

const tileStyle = (app: HomeApp) =>
  // Only regular tiles reach this — the hero renders its own glass-panel recipe below.
  app.tile
    ? // Artwork carries its own colors; only the hover glow is themed (the skin's contained warm-gold).
      { "--tile-glow": "color-mix(in srgb, var(--nc-accent-solid, #d8ab4b) 45%, transparent)" }
    : {
        "background-image": `linear-gradient(155deg, color-mix(in oklab, ${app.accent} 88%, white) -8%, ${app.accent} 42%, color-mix(in oklab, ${app.accent} 58%, black) 105%)`,
        color:
          app.glyphTone === "dark"
            ? "color-mix(in srgb, var(--nc-ink, #1a0e11) 92%, transparent)"
            : "rgba(255,255,255,0.96)",
        "--tile-glow": `color-mix(in oklab, ${app.accent} 55%, transparent)`,
      }

// `shouldSuppressOpen` lets the home screen swallow the trailing click that a pointer emits when a
// drag-to-reorder is released over the tile — otherwise reordering an app would also open it.
//
// `onDelete` is present only for tiles a person may throw away (agent-contributed apps). Its absence
// is what makes a built-in's right-click do nothing rather than offer an action that would fail.
type TileProps = { app: HomeApp; shouldSuppressOpen?: () => boolean; onDelete?: (app: HomeApp) => void }

export const AppTile: Component<TileProps> = (props) => (
  <Show when={props.app.hero} fallback={<RegularTile {...props} />}>
    <HeroTile {...props} />
  </Show>
)

const openUnlessDragged = (props: TileProps) => {
  if (props.shouldSuppressOpen?.()) return
  props.app.open()
}

/** Right-click a removable tile → delete it. The launcher's only context action, so it is the menu. */
const contextMenu = (props: TileProps) => (event: MouseEvent) => {
  if (!props.onDelete) return
  event.preventDefault()
  props.onDelete(props.app)
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

const RegularTile: Component<TileProps> = (props) => (
  <button
    type="button"
    class="group flex flex-col items-center gap-2.5 w-full max-w-[5rem] select-none focus:outline-none"
    onClick={() => openUnlessDragged(props)}
    onContextMenu={contextMenu(props)}
    aria-label={props.app.title}
    title={props.app.subtitle}
  >
    {/* w-full + aspect-square (not a fixed size) so the square shrinks with its grid track on
        phone widths instead of overflowing the viewport. */}
    <div
      class="relative flex items-center justify-center w-full aspect-square rounded-[1.375rem] transition-all duration-150 group-hover:-translate-y-1 group-active:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-[var(--v2-border-border-focus)]"
      classList={{
        // Artwork: the PNG has its own frame/bevel, so shadow+glow follow its alpha (drop-shadow)
        // and no ring/sheen is painted on the wrapper (a second frame reads as a double border).
        "[filter:drop-shadow(0_8px_20px_rgba(3,1,8,0.55))] group-hover:[filter:drop-shadow(0_10px_26px_rgba(3,1,8,0.5))_drop-shadow(0_0_16px_var(--tile-glow))]":
          !!props.app.tile,
        // One source of truth for the glyph-only artwork exception. The gold outer hairline and
        // purple inset line are the same visual contract carried inside every finished tile PNG.
        "overflow-hidden border-2 border-[#d7a73f] bg-[radial-gradient(circle_at_50%_30%,#3b2050_0%,#251132_62%,#160b20_100%)] shadow-[inset_0_0_0_2px_#160b20,inset_0_0_0_3px_#68417f]":
          !!props.app.tileNeedsFrame,
        "shadow-[var(--v2-elevation-floating)] ring-1 ring-white/15 group-hover:shadow-[0_10px_28px_var(--tile-glow),var(--v2-elevation-floating)] after:absolute after:inset-0 after:rounded-[inherit] after:bg-gradient-to-b after:from-white/20 after:via-white/0 after:to-black/10 after:pointer-events-none":
          !props.app.tile,
      }}
      style={tileStyle(props.app)}
    >
      <Show
        when={props.app.tile}
        fallback={<Icon name={props.app.icon as ComponentProps<typeof Icon>["name"]} class="size-10" />}
      >
        {(src) => (
          <img
            src={src()}
            alt=""
            draggable={false}
            class="absolute inset-0 size-full object-contain select-none"
            classList={{ "p-2.5": !!props.app.tileNeedsFrame }}
          />
        )}
      </Show>
      <TileBadge app={props.app} />
    </div>
    <span class="text-[13px] font-medium leading-tight text-v2-text-text-base/90 truncate max-w-full text-center [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
      {props.app.title}
    </span>
  </button>
)

// The hero is the skin's hero panel AND the system monitor: dark panel glass (gradient + grain)
// inside a gold frame, the circuit motif as atmosphere, the NOVA mark centered, and a row of live
// numbers along the bottom — threads running, combined throughput, memory pressure.
//
// ⚠️ **No app label, deliberately** (owner, 2026-08-13). The tile used to spend its headline on the
// word "Chats" over a fixed tagline; the artwork and the mark already say which app this is, so the
// words went to the one thing a launcher cannot otherwise tell you — whether this machine is busy.
// The title survives as `aria-label` (and the tooltip), so nothing is lost to a screen reader.
const HeroTile: Component<TileProps> = (props) => {
  const stats = () => props.app.stats?.() ?? []
  return (
    <button
      type="button"
      class="group flex flex-col w-full h-full select-none focus:outline-none"
      onClick={() => openUnlessDragged(props)}
      onContextMenu={contextMenu(props)}
      aria-label={props.app.title}
    >
      {/* The grid span (col-span/row-span) lives on the SortableTile wrapper — this inner button just
          fills it (w-full h-full). Don't re-declare the span here (dead classes — L7). */}
      <div
        class="relative flex flex-col w-full h-full min-h-[11.5rem] overflow-hidden rounded-[1.75rem] p-5 text-left shadow-[var(--v2-elevation-floating)] transition-all duration-150 group-hover:-translate-y-1 group-hover:shadow-[0_14px_40px_var(--tile-glow),var(--v2-elevation-floating)] group-active:scale-[0.98] group-focus-visible:ring-2 group-focus-visible:ring-[var(--v2-border-border-focus)]"
        style={{
          "background-image": "var(--nc-panel-gradient), var(--nc-grain-image)",
          "background-size": "auto, 420px 420px",
          border: "1px solid color-mix(in srgb, var(--nc-accent-solid, #d8ab4b) 55%, transparent)",
          "--tile-glow": "color-mix(in srgb, var(--nc-accent-solid, #d8ab4b) 45%, transparent)",
        }}
      >
        {/* atmosphere: the circuit motif, screened low — never behind the copy's corner */}
        <div class="pointer-events-none absolute inset-0 rounded-[inherit] bg-cover bg-top opacity-[0.16] mix-blend-screen [background-image:var(--nc-ambient-image)]" />
        {/* the skin panel's top gold hairline */}
        <div class="pointer-events-none absolute inset-x-[14%] top-0 h-px opacity-40 [background:linear-gradient(90deg,transparent,var(--v2-text-text-accent),transparent)]" />
        {/* the NOVA mark, centered in the flexible space above the copy */}
        <div class="relative flex min-h-0 flex-1 items-center justify-center py-1">
          <img
            src="/assets/skin/logo-nobg.png"
            alt=""
            draggable={false}
            class="pointer-events-none h-28 max-h-full w-auto select-none object-contain [filter:drop-shadow(0_0_14px_var(--tile-glow))]"
          />
        </div>
        <TileBadge app={props.app} />
        {/* The readout. A hairline lifts it off the panel the way the skin's status strip does. */}
        {/* `justify-between`, NOT three equal columns: the tile is ~176px wide in a narrow window,
            and equal thirds gave each label 42px for a 45px word — so the longest one ellipsised
            while its neighbours sat on empty space. Sizing to content spends the width where it is
            actually needed. */}
        <div class="relative flex items-end justify-between gap-1.5 border-t border-[color-mix(in_srgb,var(--nc-accent-solid,#d8ab4b)_28%,transparent)] pt-3">
          {/* ⚠️ `<Index>`, not `<For>` (review H5, 2026-08-23). `systemLoadStats()` returns a NEW array
              of NEW objects on every call, and it chains through `useThreadActivity()` — a memo over
              the sync store's session data, which moves on every streaming tick. `<For>` keys by
              reference, so these three cells were disposed and recreated at roughly token rate while
              an agent was answering. The set is FIXED at three: position IS their identity, which is
              exactly what `<Index>` keys on. */}
          <Index each={stats()}>
            {(stat) => (
              <div class="flex min-w-0 flex-col items-center gap-0.5">
                <span
                  class="text-[17px] font-semibold leading-none tabular-nums transition-colors"
                  classList={{
                    "text-v2-text-text-base": !stat().tone,
                    // Dimmed, not hidden: an idle machine still reports, it just does not ask for
                    // attention. `faint` is the same token the empty states use.
                    "text-v2-text-text-faint": stat().tone === "idle",
                    "text-v2-state-fg-danger": stat().tone === "warn",
                  }}
                >
                  {stat().value}
                </span>
                {/* Tight tracking + a nowrap ellipsis backstop: three columns share ~200px on a
                    phone-width tile, and a label that truncates to "TOKE…" is worse than none. */}
                <span class="max-w-full truncate text-[9px] font-medium uppercase tracking-[0.04em] text-v2-text-text-muted">
                  {stat().label}
                </span>
              </div>
            )}
          </Index>
        </div>
      </div>
    </button>
  )
}
