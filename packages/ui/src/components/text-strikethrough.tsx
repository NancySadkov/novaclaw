import type { JSX } from "solid-js"
import { createEffect, on, onMount } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { useSpring } from "./motion-spring"

export function TextStrikethrough(props: {
  /** Whether the strikethrough is active (line drawn across). */
  active: boolean
  /** The text to display. Rendered twice internally (base + decoration overlay). */
  text: string
  /** Spring visual duration in seconds. Default 0.35. */
  visualDuration?: number
  class?: string
  style?: JSX.CSSProperties
}) {
  const progress = useSpring(
    () => (props.active ? 1 : 0),
    () => ({ visualDuration: props.visualDuration ?? 0.35, bounce: 0 }),
  )

  let baseRef: HTMLSpanElement | undefined
  let containerRef: HTMLSpanElement | undefined
  const [state, setState] = createStore({
    textWidth: 0,
    containerWidth: 0,
  })
  const textWidth = () => state.textWidth
  const containerWidth = () => state.containerWidth

  const measure = () => {
    if (baseRef) setState("textWidth", baseRef.scrollWidth)
    if (containerRef) setState("containerWidth", containerRef.offsetWidth)
  }

  onMount(measure)
  createResizeObserver(() => containerRef, measure)
  // 🔴 THE TEXT IS AN INPUT TO THE MEASUREMENT, so it has to be one of its triggers. `measure` reads
  // `baseRef.scrollWidth`, and the two triggers above between them cover "the component appeared"
  // and "the container was resized" — neither of which happens when a row's `content` is rewritten
  // by a later `todowrite`. The dock lays its rows out in a grid whose column width the dock owns,
  // so the container does NOT resize when the string inside it changes length, and `textWidth` kept
  // the previous string's width: the strike line stopped short of the new text or ran past it.
  // `text-reveal.tsx` in this same directory already measures under `on(() => props.text, …)`; this
  // is that trigger, not a new idea.
  createEffect(on(() => props.text, measure, { defer: true }))

  // Revealed pixels from left = progress * textWidth
  const revealedPx = () => {
    const tw = textWidth()
    return tw > 0 ? progress() * tw : 0
  }

  // Overlay clip: hide everything to the right of revealed area
  const overlayClip = () => {
    const cw = containerWidth()
    const tw = textWidth()
    if (cw <= 0 || tw <= 0) return `inset(0 ${(1 - progress()) * 100}% 0 0)`
    const remaining = Math.max(0, cw - revealedPx())
    return `inset(0 ${remaining}px 0 0)`
  }

  // Base clip: hide everything to the left of revealed area (complementary)
  const baseClip = () => {
    const px = revealedPx()
    if (px <= 0.5) return "none"
    return `inset(0 0 0 ${px}px)`
  }

  return (
    <span
      data-component="text-strikethrough"
      class={props.class}
      style={{ display: "grid", ...props.style }}
      ref={containerRef}
    >
      <span ref={baseRef} style={{ "grid-area": "1 / 1", "clip-path": baseClip() }}>
        {props.text}
      </span>
      <span
        aria-hidden="true"
        style={{
          "grid-area": "1 / 1",
          "text-decoration": "line-through",
          "pointer-events": "none",
          "clip-path": overlayClip(),
        }}
      >
        {props.text}
      </span>
    </span>
  )
}
