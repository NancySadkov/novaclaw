import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { InfoPopoverV2 } from "@novaclaw/ui/v2/info-popover-v2"

/**
 * THE `?` DISCLOSURE OPENS ON A TAP, which the `TooltipV2` it replaced did not.
 *
 * 🔴 The defect this pins is documented in `settings-v2/explain.tsx` and was measured 2026-08-27:
 * `TooltipV2`'s trigger calls `arm()` on pointer-down, which SUPPRESSES the tooltip, so hover worked
 * and a click or tap did nothing. On a phone every explanation in the product was unreachable —
 * which fails AGENTS.md principle 12's gate ("a normal user can configure every capability without
 * knowing a value that is not on screen") for a sighted phone user.
 *
 * A source ratchet cannot catch this: the failure is a gesture producing no state change, and the
 * code reads correctly either way. So these drive the real component through the real events.
 */

let dispose: (() => void) | undefined
const originalMatchMedia = globalThis.window?.matchMedia
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
  if (originalMatchMedia === undefined) delete (globalThis.window as { matchMedia?: unknown }).matchMedia
  else globalThis.window!.matchMedia = originalMatchMedia
})

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Decide what the component believes about the primary pointer. */
const setHoverCapable = (value: boolean) => {
  globalThis.window!.matchMedia = ((query: string) => ({
    matches: value && query === "(hover: hover)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never
}

const mount = () => {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <InfoPopoverV2 label="Model class">Fast is for labeling and searching.</InfoPopoverV2>, host)
}

const trigger = () => document.querySelector<HTMLElement>('[data-component="info-popover-v2-trigger"]')!
/** Kobalte's popover trigger carries its own state, so this cannot be fooled by an exit animation. */
const open = () => trigger().getAttribute("aria-expanded") === "true"
const content = () => document.querySelector<HTMLElement>('[data-component="info-popover-v2"]')
const pointer = (type: string, node: Element, pointerType = "mouse") =>
  node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType }))
/** A real touch tap: pointerenter, pointerdown, pointerup, click — in the order a browser fires them. */
const tap = async () => {
  pointer("pointerenter", trigger(), "touch")
  pointer("pointerdown", trigger(), "touch")
  pointer("pointerup", trigger(), "touch")
  trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))
  await settle()
}

test("the trigger is a real button carrying the field's accessible name", () => {
  setHoverCapable(false)
  mount()
  expect(trigger().tagName).toBe("BUTTON")
  expect(trigger().getAttribute("aria-label")).toBe("Model class")
  expect(trigger().textContent).toBe("?")
})

test("a TAP opens it on a device that cannot hover, and a second tap closes it", async () => {
  setHoverCapable(false)
  mount()
  await tap()
  expect(open()).toBe(true)
  expect(content()?.textContent).toContain("Fast is for labeling and searching.")
  await tap()
  expect(open()).toBe(false)
})

test("hover opens it on a pointer device and leaving closes it", async () => {
  setHoverCapable(true)
  mount()
  pointer("pointerenter", trigger())
  await settle()
  expect(open()).toBe(true)
  pointer("pointerleave", trigger())
  await settle()
  expect(open()).toBe(false)
})

test("a mouse click does not close the panel the pointer is still resting on", async () => {
  // The trap the old tooltip fell into: a click that reaches Kobalte's toggle closes what hover just
  // opened, so the control appears to do nothing.
  setHoverCapable(true)
  mount()
  pointer("pointerenter", trigger())
  await settle()
  trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))
  await settle()
  expect(open()).toBe(true)
})
