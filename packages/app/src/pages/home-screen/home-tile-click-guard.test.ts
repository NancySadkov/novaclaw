import { describe, expect, test } from "bun:test"
import { createHomeTileClickGuard } from "./home-tile-click-guard"

// Ported from outside contribution #11 by @DassaultFalconKing, which
// extracted this decision out of `home-screen.tsx`'s pointer listeners so it could be tested at
// all. The upstream tests are kept; the last two are added here.

describe("createHomeTileClickGuard", () => {
  test("suppresses a trailing launcher click after a drag", () => {
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 7, x: 10, y: 10 })
    guard.move({ pointerID: 7, x: 25, y: 10 })

    expect(guard.shouldSuppress()).toBe(true)
  })

  test("does not suppress a click after a tap or another pointer moves", () => {
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 7, x: 10, y: 10 })
    guard.move({ pointerID: 8, x: 50, y: 50 })
    guard.move({ pointerID: 7, x: 18, y: 10 })

    expect(guard.shouldSuppress()).toBe(false)
  })

  test("keeps the trailing click guarded until the caller clears it", () => {
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 7, x: 10, y: 10 })
    guard.move({ pointerID: 7, x: 25, y: 10 })

    expect(guard.end(7)).toBe(true)
    expect(guard.shouldSuppress()).toBe(true)
    guard.clear()
    expect(guard.shouldSuppress()).toBe(false)
  })

  test("ignores an end from a pointer that never owned the gesture", () => {
    // The caller uses this return value to decide whether to schedule the clear. If a foreign
    // pointer's `pointerup` could claim the gesture, the real pointer's drag would be cleared
    // early and the trailing click would open the app the user was reordering.
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 7, x: 10, y: 10 })
    guard.move({ pointerID: 7, x: 25, y: 10 })

    expect(guard.end(8)).toBe(false)
    expect(guard.shouldSuppress()).toBe(true)
    expect(guard.end(7)).toBe(true)
  })

  test("movement before any gesture begins cannot arm the guard", () => {
    // THE REGRESSION THIS PORT EXISTS FOR. The predecessor armed on every window pointerdown, so a
    // drag that started anywhere in the shell — and, worse, one that never received a pointerup —
    // left the launcher inert. With no `begin`, movement is ignored entirely.
    const guard = createHomeTileClickGuard()
    guard.move({ pointerID: 7, x: 400, y: 400 })
    guard.move({ pointerID: 7, x: 10, y: 10 })

    expect(guard.shouldSuppress()).toBe(false)
  })
})

describe("clear is scoped to a pointer when one is named (H6)", () => {
  test("🔴 a SECOND pointer cannot abandon the first pointer's live gesture", () => {
    // The hole: `home-screen.tsx` clears whenever a pointerdown lands outside a tile, and did so
    // with no id test. A stray touch mid-drag reset `dragged`, and the first pointer's release over
    // a tile then emitted an unswallowed click — the app opened while the user was reordering.
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 1, x: 0, y: 0 })
    guard.move({ pointerID: 1, x: 100, y: 0 })
    expect(guard.shouldSuppress()).toBe(true)
    guard.clear(2)
    expect(guard.shouldSuppress()).toBe(true)
  })

  test("the OWNING pointer may still abandon its own gesture", () => {
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 1, x: 0, y: 0 })
    guard.move({ pointerID: 1, x: 100, y: 0 })
    guard.clear(1)
    expect(guard.shouldSuppress()).toBe(false)
  })

  test("⚠️ an unqualified clear still means 'abandon whatever is live'", () => {
    // The `blur` and unmount paths have no pointer id and must keep working — a gesture left armed
    // makes every launcher tile inert until the next pointerdown.
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 1, x: 0, y: 0 })
    guard.move({ pointerID: 1, x: 100, y: 0 })
    guard.clear()
    expect(guard.shouldSuppress()).toBe(false)
  })

  test("clearing with an id when NOTHING is live still resets", () => {
    const guard = createHomeTileClickGuard()
    guard.begin({ pointerID: 1, x: 0, y: 0 })
    guard.move({ pointerID: 1, x: 100, y: 0 })
    guard.end(1)
    // `end` released the pointer but left `dragged` set — that is what the caller's scheduled
    // `clear` is for, and it must not be refused because the pointer record is already gone.
    guard.clear(1)
    expect(guard.shouldSuppress()).toBe(false)
  })
})
