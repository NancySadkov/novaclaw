import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { createSignal, type JSX } from "solid-js"
import { useDialogPortal } from "../../context/dialog-portal"

/**
 * The `?` in a circle, with the explanation behind it — HOVER on a pointer, TAP on a touch screen.
 *
 * 🔴 **Why this exists as a popover rather than the `TooltipV2` it replaces.** `explain.tsx`'s own
 * note recorded the defect: `TooltipV2` is a hover/focus primitive and its trigger calls `arm()` on
 * pointer-down, which SUPPRESSES the tooltip — correct for an icon button, exactly wrong for a
 * control whose only purpose is to be opened. Measured 2026-08-27: hover worked, a click or tap did
 * nothing, so on a phone every explanation in the product was unreachable. That is not a tooltip bug
 * to patch: "press to toggle" is what a popover is, and Kobalte's own `Popover` already owns the
 * press/outside-click/Escape behaviour. So the fix is the primitive the note named.
 *
 * ⚠️ **Hover and tap are driven by DIFFERENT rules, on purpose.** Where the primary pointer can
 * hover, hovering opens and leaving closes — and a mouse click is deliberately inert, because letting
 * it reach Kobalte's toggle would close the panel the pointer is still resting on. Where it cannot
 * hover (a phone), a tap toggles and stays until it is tapped again or the user taps away. The one
 * awkward case is a touch screen with a mouse attached; `(hover: hover)` follows the PRIMARY input,
 * so it reads as a phone until a mouse is plugged in, which is the honest answer.
 *
 * The label is on the trigger (`aria-label`) and the panel is reachable by keyboard: the trigger is
 * a real button, so Enter/Space toggles it like a pointer click.
 */
export function InfoPopoverV2(props: {
  /** Accessible name for the trigger — the field this explanation belongs to. */
  readonly label: string
  readonly children: JSX.Element
  readonly contentClass?: string
}) {
  const portal = useDialogPortal()
  const [hovered, setHovered] = createSignal(false)
  const [pinned, setPinned] = createSignal(false)
  const shown = () => hovered() || pinned()
  /**
   * Set for the one `onOpenChange` that Kobalte raises from OUR own click, so the toggle it performs
   * after calling our handler cannot undo the state we just set. A module-local `let` rather than a
   * signal: it is a one-shot latch, not something the view renders.
   */
  let ownToggle = false
  const close = () => {
    setHovered(false)
    setPinned(false)
  }
  const hoverCapable = () => typeof window !== "undefined" && (window.matchMedia?.("(hover: hover)").matches ?? false)

  return (
    <KobaltePopover
      placement="top"
      gutter={6}
      modal={false}
      open={shown()}
      onOpenChange={(next) => {
        // Consume the latch on ANY change: Kobalte's `toggle()` always reports the value it moved
        // AWAY from, and both directions of that are our own click rather than a real close.
        if (ownToggle) {
          ownToggle = false
          return
        }
        if (!next) close()
      }}
    >
      <KobaltePopover.Trigger
        data-slot="settings-explain"
        data-component="info-popover-v2-trigger"
        aria-label={props.label}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        // A tap fires pointerenter before pointerdown; clearing it here keeps that transient hover
        // from pinning the panel open on a device that never leaves.
        onPointerDown={() => setHovered(false)}
        onClick={(event) => {
          // The latch covers both the inert desktop click and Kobalte's own toggle after a tap.
          ownToggle = true
          if (hoverCapable() && (event as MouseEvent).detail > 0) return
          setPinned((value) => !value)
        }}
      >
        ?
      </KobaltePopover.Trigger>
      <KobaltePopover.Portal mount={portal?.()}>
        <KobaltePopover.Content data-component="info-popover-v2" data-placement="top" class={props.contentClass}>
          {props.children}
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}
