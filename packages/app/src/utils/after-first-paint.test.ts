import { afterEach, describe, expect, test } from "bun:test"
import { afterFirstPaint } from "./after-first-paint"

// 🔴 THE CASE THIS EXISTS FOR IS THE ONE WITH NO FRAME.
//
// `requestAnimationFrame` never fires in a hidden tab. `context/layout.tsx` deferred its
// `loadSessions` call to a bare rAF, so a window opened in the background loaded no project's
// sessions and rendered an empty chat list — while the SSE stream (which had the guard) started
// normally, so the store looked alive and the list looked like "you have no chats".
//
// The visible-tab case is the easy half and is asserted too, but a green run that only proved the
// visible path would be proving the half that already worked.

type Frame = () => void

const withEnvironment = (input: { readonly visibility: string; readonly raf: boolean }) => {
  const frames: Frame[] = []
  const originalRaf = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const originalDocument = globalThis.document

  Object.defineProperty(globalThis, "document", {
    value: { visibilityState: input.visibility },
    configurable: true,
    writable: true,
  })
  if (input.raf) {
    globalThis.requestAnimationFrame = ((callback: Frame) => frames.push(callback)) as never
    globalThis.cancelAnimationFrame = (() => {}) as never
  } else {
    // @ts-expect-error deliberately removing the global to model an environment without it
    delete globalThis.requestAnimationFrame
  }

  return {
    frames,
    paint: () => {
      const pending = frames.splice(0, frames.length)
      for (const frame of pending) frame()
    },
    restore: () => {
      globalThis.requestAnimationFrame = originalRaf
      globalThis.cancelAnimationFrame = originalCancel
      Object.defineProperty(globalThis, "document", {
        value: originalDocument,
        configurable: true,
        writable: true,
      })
    },
  }
}

let active: { restore: () => void } | undefined
afterEach(() => {
  active?.restore()
  active = undefined
})

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe("afterFirstPaint", () => {
  test("a HIDDEN document runs the callback anyway — no frame will ever arrive", async () => {
    const environment = withEnvironment({ visibility: "hidden", raf: true })
    active = environment
    let ran = 0
    afterFirstPaint(() => {
      ran += 1
    })
    await tick()
    expect(ran, "the callback never ran in a hidden tab — this is the layout.tsx defect").toBe(1)
    expect(environment.frames.length, "a hidden document must not wait on a frame at all").toBe(0)
  })

  test("an environment with no requestAnimationFrame runs the callback", async () => {
    active = withEnvironment({ visibility: "visible", raf: false })
    let ran = 0
    afterFirstPaint(() => {
      ran += 1
    })
    await tick()
    expect(ran).toBe(1)
  })

  test("a VISIBLE document waits for the frame, then runs once", async () => {
    const environment = withEnvironment({ visibility: "visible", raf: true })
    active = environment
    let ran = 0
    afterFirstPaint(() => {
      ran += 1
    })
    await tick()
    expect(ran, "it ran before the frame — the deferral is not deferring").toBe(0)
    environment.paint()
    await tick()
    expect(ran).toBe(1)
  })

  test("cancel before the frame means the callback never runs", async () => {
    const environment = withEnvironment({ visibility: "visible", raf: true })
    active = environment
    let ran = 0
    const cancel = afterFirstPaint(() => {
      ran += 1
    })
    cancel()
    environment.paint()
    await tick()
    expect(ran).toBe(0)
  })

  test("cancel after the callback has run is harmless and does not re-run it", async () => {
    const environment = withEnvironment({ visibility: "visible", raf: true })
    active = environment
    let ran = 0
    const cancel = afterFirstPaint(() => {
      ran += 1
    })
    environment.paint()
    await tick()
    cancel()
    await tick()
    expect(ran).toBe(1)
  })

  test("`timeoutMs` fires when the frame never comes, and only once when it does", async () => {
    const environment = withEnvironment({ visibility: "visible", raf: true })
    active = environment
    let ran = 0
    afterFirstPaint(
      () => {
        ran += 1
      },
      { timeoutMs: 10 },
    )
    await tick(30)
    expect(ran, "bootstrap would hang on a visible window that has not painted yet").toBe(1)
    // The frame arriving late must not run it a second time.
    environment.paint()
    await tick()
    expect(ran).toBe(1)
  })
})
