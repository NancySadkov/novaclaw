import { Show, splitProps, type Component, type JSX } from "solid-js"
import { GoldGlyph } from "@/components/gold-glyph"

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

/**
 * The title row every app page draws directly under the frame: glyph, name, one faint sentence of
 * hint, then whatever controls the page owns.
 *
 * 🔴 **Why this exists even though `AppPage` deliberately shares only the frame.** It was written out
 * SEVEN times, and in six of them the class string
 * `"flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5"` was byte-identical
 * (). `debug.tsx` and `registry.tsx` had already drifted to `py-3`, `gap-2` and a `size-5`
 * glyph — the drift a seven-way copy predicts, and the reason a header is not in the same category
 * as clipping. Clipping genuinely differs per page; a title row does not.
 *
 * ⚠️ **`hint` truncates, and that is load-bearing rather than decorative.** It is
 * `min-w-0 flex-1 truncate`, so it both absorbs the free space (pushing `children` to the right edge)
 * and refuses to push the trailing controls off-screen on a narrow window. A caller that renders its
 * own hint element loses both.
 *
 * ⚠️ **An ABSENT hint renders nothing at all — no spacer.** `files.tsx` has no hint and its buttons
 * sit immediately after the title; a `flex-1` filler would have shoved them to the right edge. The
 * hint IS the spacer, which is why its absence has to be a real absence.
 *
 * ⚠️ **A page may still have NO header.** `contacts.tsx` deliberately renders none, and that is a
 * product decision, not an omission — this component is offered, never imposed.
 *
 * ⚠️ **`dense` reproduces the debug/registry variant EXACTLY**, down to the 14px title and the
 * non-flexing 12px hint, rather than normalising them. That is deliberate: nothing measured says
 * `py-3` is wrong for a dense diagnostic surface, and a header merge is not the place to change what
 * two screens look like. What it removes is the SILENCE — the two sizes were a drift nobody chose;
 * now a page states which one it wants.
 */
export const AppPageHeader: Component<{
  /** `GoldGlyph` name. Omit for a header that is text only. */
  glyph?: string
  title: JSX.Element
  /** One faint sentence. Truncates rather than wrapping — see above. Absent renders nothing. */
  hint?: JSX.Element
  /**
   * The `gap-2` / `py-3` / `size-5` / 14px-title variant `debug.tsx` and `registry.tsx` drifted into.
   * Developer surfaces pack more into the row; naming it keeps it a choice instead of an accident.
   */
  dense?: boolean
  /** Trailing controls, right-aligned by the hint's `flex-1`. */
  children?: JSX.Element
}> = (props) => (
  <div
    data-component="app-page-header"
    class="flex items-center border-b border-v2-border-border-base px-4"
    classList={{ "gap-3 py-2.5": !props.dense, "gap-2 py-3": props.dense }}
  >
    <Show when={props.glyph}>{(name) => <GoldGlyph name={name()} class={props.dense ? "size-5" : "size-6"} />}</Show>
    <span
      class="font-semibold"
      classList={{ "text-[15px]": !props.dense, "text-[14px] text-v2-text-text-base": props.dense }}
    >
      {props.title}
    </span>
    <Show when={props.hint !== undefined}>
      <span
        class="text-v2-text-text-faint"
        classList={{ "min-w-0 flex-1 truncate text-xs": !props.dense, "text-[12px]": props.dense }}
      >
        {props.hint}
      </span>
    </Show>
    {props.children}
  </div>
)
