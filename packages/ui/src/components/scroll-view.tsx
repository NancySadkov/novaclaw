import { createSignal, onCleanup, onMount, splitProps, type ComponentProps, Show, mergeProps } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"

export interface ScrollViewProps extends ComponentProps<"div"> {
  viewportRef?: (el: HTMLDivElement) => void
  orientation?: "vertical" | "horizontal" // currently only vertical is fully implemented for thumb
}

export const scrollKey = (event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

  switch (event.key) {
    case "PageDown":
      return "page-down"
    case "PageUp":
      return "page-up"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
  }
}

export function scrollTopFromThumbPointer(input: {
  pointer: number
  viewportTop: number
  grabOffset: number
  clientHeight: number
  scrollHeight: number
  thumbHeight: number
}) {
  const padding = 8
  const maxThumbTop = input.clientHeight - padding * 2 - input.thumbHeight
  if (maxThumbTop <= 0) return 0
  const thumbTop = Math.max(0, Math.min(input.pointer - input.viewportTop - padding - input.grabOffset, maxThumbTop))
  return (thumbTop / maxThumbTop) * Math.max(0, input.scrollHeight - input.clientHeight)
}

export function ScrollView(props: ScrollViewProps) {
  const i18n = useI18n()
  const merged = mergeProps({ orientation: "vertical" }, props)
  const [local, events, rest] = splitProps(
    merged,
    ["class", "children", "viewportRef", "orientation", "style"],
    [
      "onScroll",
      "onWheel",
      "onTouchStart",
      "onTouchMove",
      "onTouchEnd",
      "onTouchCancel",
      "onPointerDown",
      "onClick",
      "onKeyDown",
    ],
  )

  let rootRef!: HTMLDivElement
  let viewportRef!: HTMLDivElement
  let thumbRef!: HTMLDivElement

  const [state, setState] = createStore({
    isHovered: false,
    isDragging: false,
    thumbHeight: 0,
    thumbTop: 0,
    showThumb: false,
  })
  const isHovered = () => state.isHovered
  const isDragging = () => state.isDragging
  const thumbHeight = () => state.thumbHeight
  const thumbTop = () => state.thumbTop
  const showThumb = () => state.showThumb

  const updateThumb = () => {
    if (!viewportRef) return
    const { scrollTop, scrollHeight, clientHeight } = viewportRef

    if (scrollHeight <= clientHeight || scrollHeight === 0) {
      setState("showThumb", false)
      return
    }

    setState("showThumb", true)
    const trackPadding = 8
    const trackHeight = clientHeight - trackPadding * 2

    const minThumbHeight = 32
    // Calculate raw thumb height based on ratio
    let height = (clientHeight / scrollHeight) * trackHeight
    height = Math.max(height, minThumbHeight)

    const maxScrollTop = scrollHeight - clientHeight
    const maxThumbTop = trackHeight - height

    const top = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxThumbTop : 0

    // Ensure thumb stays within bounds (shouldn't be necessary due to math above, but good for safety)
    const boundedTop = trackPadding + Math.max(0, Math.min(top, maxThumbTop))

    setState("thumbHeight", height)
    setState("thumbTop", boundedTop)
  }

  /**
   * WHAT THE THUMB IS MEASURED AGAINST — kept current, not sampled once.
   *
   * 🔴 This used to be `createResizeObserver([viewportRef, viewportRef.firstElementChild], …)`, and
   * both halves of that line were wrong in the same direction. `firstElementChild` was read once,
   * inside `onMount`, so the observer bound to whichever element the consumer happened to have
   * rendered at that instant; and a plain array is not an accessor, so the primitive's effect
   * tracked nothing and never re-read it. The viewport's OWN size does not change when its content
   * grows, so a consumer whose child is replaced after mount — a `<Switch>` still in its loading arm
   * when the file viewer mounts is the live one — got no thumb at all until the user produced a
   * scroll event, which is the only other caller of `updateThumb`.
   *
   * ⚠️ The fix is not a wrapper element. `ScrollView` could render its own stable child and observe
   * that, but the viewport is a flex container in at least one consumer's stylesheet
   * (`session-ui/src/components/session-review.css`) and an inserted box would take the flex item's
   * place — a layout regression in a component whose job is layout. Watching the child list instead
   * keeps the DOM exactly as consumers wrote it.
   *
   * ⚠️ A `MutationObserver`, not another `ResizeObserver`: the event here is "the children were
   * swapped", which has no size to report. It observes `childList` only, without `subtree` — a
   * deeper change alters the direct child's height, and that direct child is under the resize
   * observer already.
   */
  const [observed, setObserved] = createSignal<Element[]>([])
  createResizeObserver(observed, updateThumb)

  onMount(() => {
    if (local.viewportRef) {
      local.viewportRef(viewportRef)
    }

    const syncObserved = () => {
      setObserved([viewportRef, ...Array.from(viewportRef.children)])
      updateThumb()
    }

    const children = new MutationObserver(syncObserved)
    children.observe(viewportRef, { childList: true })
    onCleanup(() => children.disconnect())

    syncObserved()
  })

  const onThumbPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setState("isDragging", true)
    const grabOffset = e.clientY - thumbRef.getBoundingClientRect().top

    thumbRef.setPointerCapture(e.pointerId)

    const onPointerMove = (e: PointerEvent) => {
      const { scrollHeight, clientHeight } = viewportRef
      viewportRef.scrollTop = scrollTopFromThumbPointer({
        pointer: e.clientY,
        viewportTop: viewportRef.getBoundingClientRect().top,
        grabOffset,
        clientHeight,
        scrollHeight,
        thumbHeight: thumbHeight(),
      })
    }

    const done = (e: PointerEvent) => {
      setState("isDragging", false)
      thumbRef.releasePointerCapture(e.pointerId)
      thumbRef.removeEventListener("pointermove", onPointerMove)
      thumbRef.removeEventListener("pointerup", done)
      thumbRef.removeEventListener("pointercancel", done)
    }

    thumbRef.addEventListener("pointermove", onPointerMove)
    thumbRef.addEventListener("pointerup", done)
    thumbRef.addEventListener("pointercancel", done)
  }

  // Keybinds implementation
  // We ensure the viewport has a tabindex so it can receive focus
  // We can also explicitly catch PageUp/Down if we want smooth scroll or specific behavior,
  // but native usually handles this perfectly. Let's explicitly ensure it behaves well.
  const onKeyDown = (e: KeyboardEvent) => {
    // If user is focused on an input inside the scroll view, don't hijack keys
    if (document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      return
    }

    const next = scrollKey(e)
    if (!next) return

    const scrollAmount = viewportRef.clientHeight * 0.8
    const lineAmount = 40

    switch (next) {
      case "page-down":
        e.preventDefault()
        viewportRef.scrollBy({ top: scrollAmount, behavior: "smooth" })
        break
      case "page-up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -scrollAmount, behavior: "smooth" })
        break
      case "home":
        e.preventDefault()
        viewportRef.scrollTo({ top: 0, behavior: "smooth" })
        break
      case "end":
        e.preventDefault()
        viewportRef.scrollTo({ top: viewportRef.scrollHeight, behavior: "smooth" })
        break
      case "up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -lineAmount, behavior: "smooth" })
        break
      case "down":
        e.preventDefault()
        viewportRef.scrollBy({ top: lineAmount, behavior: "smooth" })
        break
    }
  }

  return (
    <div
      ref={rootRef}
      class={`scroll-view ${local.class || ""}`}
      style={local.style}
      onPointerEnter={() => setState("isHovered", true)}
      onPointerLeave={() => setState("isHovered", false)}
      {...rest}
    >
      {/* Viewport */}
      <div
        ref={viewportRef}
        class="scroll-view__viewport"
        onScroll={(e) => {
          updateThumb()
          if (typeof events.onScroll === "function") events.onScroll(e as any)
        }}
        onWheel={events.onWheel as any}
        onTouchStart={events.onTouchStart as any}
        onTouchMove={events.onTouchMove as any}
        onTouchEnd={events.onTouchEnd as any}
        onTouchCancel={events.onTouchCancel as any}
        onPointerDown={events.onPointerDown as any}
        onClick={events.onClick as any}
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
        onKeyDown={(e) => {
          onKeyDown(e)
          if (typeof events.onKeyDown === "function") events.onKeyDown(e as any)
        }}
      >
        {local.children}
      </div>

      {/* Thumb Overlay */}
      <Show when={showThumb()}>
        <div
          ref={thumbRef}
          onPointerDown={onThumbPointerDown}
          class="scroll-view__thumb"
          data-visible={isHovered() || isDragging()}
          data-dragging={isDragging()}
          style={{
            height: `${thumbHeight()}px`,
            transform: `translateY(${thumbTop()}px)`,
            "z-index": 100, // ensure it displays over content
          }}
        />
      </Show>
    </div>
  )
}
