type PointerStart = {
  pointerID: number
  x: number
  y: number
}

/**
 * Decides whether the trailing click after a launcher drag should be swallowed.
 *
 * solid-dnd's pointer sensor releases the drag over whatever tile the pointer is above, which fires
 * a compatibility click that would OPEN the app the user was only reordering. We detect a real drag
 * by pointer TRAVEL rather than by the sensor's `onDragStart`, because that also fires after a
 * stationary 250 ms hold — and a slow tap must still open the app.
 *
 * ⚠️ Two properties make this safe, and the version this replaces had neither. Ported from
 * https://github.com/NancySadkov/novaclaw/pull/11 by @DassaultFalconKing.
 *
 * 1. **The gesture must have started on a tile.** The previous guard armed on *any* window
 *    pointerdown, so a drag anywhere in the shell set the flag and the next launcher click was
 *    swallowed. Scoping is the caller's job (it has the DOM); this module only ever sees gestures
 *    the caller chose to `begin`.
 * 2. **Movement is attributed by `pointerID`.** A second pointer — a stray touch, a pen, a
 *    trackpad gesture — cannot mark the first pointer's gesture as a drag.
 *
 * The failure this fixes is not cosmetic: `dragged` was only ever cleared on `pointerup`, so a
 * gesture that ended without one (focus lost to another window, pointer capture stolen) left the
 * flag set and **every launcher tile inert** until the next pointerdown. `home-screen.tsx`
 * therefore also clears on `pointercancel` and on window `blur`.
 */
export function createHomeTileClickGuard(travel = 10) {
  let pointer: PointerStart | undefined
  let dragged = false

  return {
    begin(next: PointerStart) {
      pointer = next
      dragged = false
    },
    move(next: PointerStart) {
      if (!pointer || pointer.pointerID !== next.pointerID) return
      if (Math.hypot(next.x - pointer.x, next.y - pointer.y) <= travel) return
      dragged = true
    },
    /** True when this pointer owned the gesture — the caller then schedules `clear`. */
    end(pointerID: number) {
      if (!pointer || pointer.pointerID !== pointerID) return false
      pointer = undefined
      return true
    },
    clear() {
      pointer = undefined
      dragged = false
    },
    shouldSuppress() {
      return dragged
    },
  }
}
