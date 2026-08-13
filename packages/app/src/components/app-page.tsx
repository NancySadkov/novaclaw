import { splitProps, type Component, type JSX } from "solid-js"

/**
 * The root frame every full-screen app page renders into.
 *
 * ⚠️ **An app is FULL SCREEN, not a card floating over the desktop** (owner, 2026-08-13). Eight pages
 * each carried the same `m-2 rounded-[10px] shadow-[var(--v2-elevation-raised)]`, which drew a second
 * window frame *inside* the OS window's own frame: an 8px moat of wallpaper, a rounded corner and a
 * drop shadow on all four sides. That is the vocabulary of a modal — it reads as something floating
 * *over* the home screen that a click outside should dismiss — and it spends real estate restating a
 * border the window manager already draws. Apps are places you go, not sheets that hover.
 *
 * What is shared here is the FRAME (opaque app ground, full bleed, no elevation). Clipping stays with
 * the page because it genuinely differs: most apps own their scrolling internally (`overflow-hidden`
 * plus a scroll container inside), while the Tasks list scrolls the page itself below `lg`.
 */
export const AppPage: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => {
  // Forwards every other div attribute: Files puts its keyboard shortcuts and click-away handler on
  // the page root, and having to keep a hand-rolled root for that would reintroduce the divergence
  // this component exists to remove.
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <div
      {...rest}
      data-component="app-page"
      class={`min-h-0 min-w-0 flex-1 self-stretch bg-v2-background-bg-base text-v2-text-text-base ${local.class ?? ""}`}
    >
      {local.children}
    </div>
  )
}
