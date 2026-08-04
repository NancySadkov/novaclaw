import { describe, expect, test } from "bun:test"
import { createHomeTileClickGuard } from "./home-tile-click-guard"

// Ported from https://github.com/NancySadkov/novaclaw/pull/11 by @DassaultFalconKing, which
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
