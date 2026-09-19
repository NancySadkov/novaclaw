import { For, Show, createSignal, type Component } from "solid-js"
import { moveBoundary } from "./context-allocation"

/**
 * The five-segment context-allocation bar.
 *
 * 🔴 **One bar, five parts, and a draggable boundary between each pair.** The old panel was five
 * number boxes per session type (twenty boxes), which read as twenty independent settings when the
 * real object is ONE split that must total 100%. Segments show the split and its proportions at a
 * glance; dragging a boundary is the edit, and it can only move points between the two neighbours, so
 * the total is 100% by construction (`moveBoundary`).
 *
 * ⚠️ **Pointer AND keyboard.** Drag is the obvious gesture, but a boundary is a real control and must
 * be reachable without a pointer: it is a `role="separator"` with arrow keys (Shift for five). The
 * pointer path owns no state of its own beyond the live preview — the commit happens once, on
 * release or on a keypress, so a drag across the bar is one config write rather than one per pixel.
 */
export interface ContextAllocationBarProps {
  /** The five current shares, in `ALLOCATION_CATEGORIES` order. */
  readonly value: () => readonly number[]
  readonly onChange: (next: readonly number[]) => void
  /** Category ids, in order — used for the `data-category` colour hooks. */
  readonly categories: readonly string[]
  /** Display names, in order. */
  readonly labels: readonly string[]
  /** The accessible name for the boundary between `index` and `index + 1`. */
  readonly boundaryLabel: (index: number) => string
  /** When true a drag and the arrow keys do nothing; the bar is still readable. */
  readonly disabled?: boolean
}

export const ContextAllocationBar: Component<ContextAllocationBarProps> = (props) => {
  const [draft, setDraft] = createSignal<readonly number[] | undefined>(undefined)
  let drag: { readonly boundary: number; readonly x: number; readonly shares: readonly number[] } | undefined
  let bar: HTMLDivElement | undefined

  const shown = () => draft() ?? props.value()
  /** The right edge of share `boundary`, as a percentage of the whole bar. */
  const boundaryAt = (boundary: number) => shown().slice(0, boundary + 1).reduce((sum, share) => sum + share, 0)

  const begin = (boundary: number) => (event: PointerEvent) => {
    if (props.disabled === true) return
    event.preventDefault()
    drag = { boundary, x: event.clientX, shares: shown() }
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }
  const track = (event: PointerEvent) => {
    if (drag === undefined) return
    const width = bar?.getBoundingClientRect().width ?? 0
    // No layout (a test DOM, a hidden panel): there is no meaningful pixel→point conversion, so the
    // drag simply does not move. The arrow keys below remain the deterministic path.
    if (!(width > 0)) return
    setDraft(moveBoundary(drag.shares, drag.boundary, ((event.clientX - drag.x) / width) * 100))
  }
  const release = () => {
    const next = draft()
    if (next !== undefined) props.onChange(next)
    drag = undefined
    setDraft(undefined)
  }
  const nudge = (boundary: number) => (event: KeyboardEvent) => {
    if (props.disabled === true) return
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
    if (direction === 0) return
    event.preventDefault()
    props.onChange(moveBoundary(shown(), boundary, direction * (event.shiftKey ? 5 : 1)))
  }

  return (
    <div class="settings-v2-allocation" data-disabled={props.disabled === true ? "true" : "false"}>
      <div class="settings-v2-allocation-bar" ref={bar}>
        <For each={shown()}>
          {(share, index) => (
            <div
              class="settings-v2-allocation-seg"
              data-category={props.categories[index()]}
              style={{ width: `${share}%` }}
              title={`${props.labels[index()]}: ${share}%`}
            >
              <Show when={share >= 12}>
                <span class="settings-v2-allocation-value">{share}%</span>
              </Show>
            </div>
          )}
        </For>
        <For each={props.categories.slice(0, -1)}>
          {(_, index) => {
            const boundary = index()
            return (
              <button
                type="button"
                class="settings-v2-allocation-handle"
                style={{ left: `${boundaryAt(boundary)}%` }}
                role="separator"
                aria-orientation="vertical"
                aria-label={props.boundaryLabel(boundary)}
                aria-valuenow={shown()[boundary]}
                aria-valuemin={0}
                aria-valuemax={shown()[boundary]! + shown()[boundary + 1]!}
                tabindex={props.disabled === true ? -1 : 0}
                onPointerDown={begin(boundary)}
                onPointerMove={track}
                onPointerUp={release}
                onPointerCancel={release}
                onKeyDown={nudge(boundary)}
              />
            )
          }}
        </For>
      </div>
    </div>
  )
}
