import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import * as sound from "@/utils/sound"

/**
 * **A demo scheduled by hovering a select must not outlive the dialog that scheduled it.**
 *
 * 🔴 The class: *a timer whose handle lives outside any component's lifecycle, so nothing is in a
 * position to cancel it when its owner goes away.* The sound demo kept its `setTimeout` handle in a
 * module-level `let`, and `SelectV2` could not save it either — its `onCleanup` invokes only the
 * closure RETURNED by `onHighlight`, and the sound rows returned nothing. Hovering an option and
 * closing Settings inside 100 ms played the sound into a panel that was already gone.
 *
 * ⚠️ **The owner is the instrument here, not a stand-in for one.** `createRoot` is the same
 * mechanism the component tree disposes with, so a factory that registers `onCleanup` is verified by
 * the real thing. What this file deliberately does NOT do is drive the three sound rows from the DOM:
 * opening a Kobalte dropdown needs a real pointer, which `computer.test.ts` records as unreachable
 * from a synthetic click. That the panel builds its demo through this factory is pinned separately,
 * by the source ledger in `components/settings-v2/numeric-and-timer-ledger.test.ts`.
 */

/** Captured BEFORE the mock replaces the module, so the unarmed path is the real function. */
const realPlaySoundById = sound.playSoundById

let armed = false
const played: string[] = []

// A gated, delegating stub: the whole real module, with one export wrapped, and the wrapper is inert
// unless this file armed it. The gate matters because the gate runs every file in `test-browser` in
// ONE process, where a module mock is process-wide.
mock.module("@/utils/sound", () => ({
  ...sound,
  playSoundById: (id: string | undefined) => {
    if (!armed) return realPlaySoundById(id)
    played.push(id ?? "none")
    return Promise.resolve(() => {})
  },
}))

const { createDemoSound } = await import("@/components/settings-v2/appearance")

afterEach(() => {
  armed = false
  played.length = 0
})

/** Longer than the 100 ms debounce, so a demo that was NOT cancelled has certainly fired. */
const past = () => new Promise((resolve) => setTimeout(resolve, 220))

describe("the sound demo's lifetime", () => {
  test("disposing the owner inside the debounce window cancels the demo", async () => {
    armed = true
    let demo!: ReturnType<typeof createDemoSound>
    const dispose = createRoot((disposeRoot) => {
      demo = createDemoSound()
      return disposeRoot
    })

    demo.play("alert-01")
    // The dialog closes ~0 ms later — the window the defect lived in.
    dispose()
    await past()

    expect(played).toEqual([])
  })

  test("the control: the same demo DOES play while its owner is alive", async () => {
    armed = true
    const dispose = createRoot((disposeRoot) => {
      createDemoSound().play("alert-01")
      return disposeRoot
    })

    await past()
    expect(played).toEqual(["alert-01"])
    dispose()
  })

  test("a second hover replaces the first demo rather than stacking one on it", async () => {
    armed = true
    const dispose = createRoot((disposeRoot) => {
      const demo = createDemoSound()
      demo.play("alert-01")
      demo.play("alert-02")
      return disposeRoot
    })

    await past()
    expect(played).toEqual(["alert-02"])
    dispose()
  })
})
