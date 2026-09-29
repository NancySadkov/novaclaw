import { describe, expect, test } from "bun:test"
import {
  MAX_RENDERER_RELOADS,
  RENDERER_GRACE_MS,
  rendererRecovery,
} from "./renderer-watchdog-policy"
import { createRendererWatchdog, type RendererWindow } from "./renderer-watchdog"

/**
 * 🔴 A WEDGED RENDERER MUST RECOVER ITSELF.
 *
 * Measured 2026-09-29 on a live client against a server that was provably healthy — `/global/health`
 * answered 200 in 13 ms. The renderer froze mid-session and never recovered: the window stopped
 * painting entirely (the tab activity indicators stopped pulsing, which is a renderer no longer
 * producing frames), the server logged no client connection for the duration, and the client's network
 * service sat on six sockets that had been `Established` for 366 s and would never carry a request
 * again.
 *
 * The old response was a dialog offering to relaunch the app, open the logs, or keep waiting — three
 * manual escapes, in a product whose own rule is that it heals itself. The sidecar already killed and
 * restarted a hung process; the renderer only took a stack sample.
 *
 * These cases pin the POLICY, which is a pure function, and the WIRING, which drives real timers
 * against a fake window. What they must never permit is the two ways this can be got wrong: reloading
 * a window that was merely slow (destroying work that was about to finish), and reloading forever
 * (replacing a readable freeze with an unreadable flicker).
 */

/** Shorthand for the policy, on a small grace so the numbers below read as what they are. */
const at = (unresponsiveForMs: number, reloadsSoFar: number) =>
  rendererRecovery({ unresponsiveForMs, reloadsSoFar, graceMs: 10, maxReloads: 2 })

describe("rendererRecovery", () => {
  test("a slow frame is left alone — Electron raises this for work that still finishes", () => {
    // The single most dangerous way to write this. Reloading on the event itself destroys a window
    // that was mid-GC or mid-render and about to be fine, trading a pause the user can SEE for a
    // reload they cannot.
    expect(at(0, 0).kind).toBe("wait")
    expect(at(9, 0).kind).toBe("wait")
    // And at the SHIPPED grace, not just the test's — the number that actually governs the product.
    expect(rendererRecovery({ unresponsiveForMs: RENDERER_GRACE_MS - 1, reloadsSoFar: 0 }).kind).toBe("wait")
  })

  test("a window still dead after the grace period is rebuilt", () => {
    expect(at(10, 0)).toEqual({ kind: "reload", attempt: 1 })
    expect(at(60_000, 0)).toEqual({ kind: "reload", attempt: 1 })
    expect(rendererRecovery({ unresponsiveForMs: RENDERER_GRACE_MS, reloadsSoFar: 0 })).toEqual({
      kind: "reload",
      attempt: 1,
    })
  })

  test("a second wedge is recovered too", () => {
    expect(at(60_000, 1)).toEqual({ kind: "reload", attempt: 2 })
  })

  test("🔴 a window that keeps wedging is REPORTED, not reloaded forever", () => {
    // A reload always yields a fresh renderer, so an unbounded watchdog turns a deterministic hang
    // into an infinite reload loop: no frame is ever readable and the fault is harder to diagnose than
    // the freeze it replaced. Past the limit the answer must be "stop and say so".
    expect(at(60_000, 2)).toEqual({ kind: "give-up", attempt: 3 })
    expect(at(60_000, 9)).toEqual({ kind: "give-up", attempt: 10 })
  })

  test("the grace period and the ceiling are the documented numbers", () => {
    // Pinned so a change to either is a decision rather than a drift.
    expect(RENDERER_GRACE_MS).toBe(10_000)
    expect(MAX_RENDERER_RELOADS).toBe(2)
    // The grace must be long enough to outlast an ordinary long frame, and short enough that a person
    // waiting on a dead window is not left staring at it for a minute.
    expect(RENDERER_GRACE_MS).toBeGreaterThan(1_000)
    expect(RENDERER_GRACE_MS).toBeLessThan(30_000)
  })
})

/** A window that records what it was told, so a test can assert on reloads rather than on timing. */
function fakeWindow(over: Partial<RendererWindow> = {}) {
  const reloads: number[] = []
  const win: RendererWindow = {
    isDestroyed: () => false,
    reload: () => reloads.push(Date.now()),
    webContents: { isDestroyed: () => false, isDevToolsOpened: () => false },
    ...over,
  }
  return { win, reloads }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

describe("createRendererWatchdog", () => {
  test("reloads a window that is still dead when the grace expires", async () => {
    const { win, reloads } = fakeWindow()
    const recovered: number[] = []
    const watchdog = createRendererWatchdog(win, {
      onRecovered: (attempt) => recovered.push(attempt),
      onGivenUp: () => {},
      graceMs: 10,
    })
    watchdog.arm()
    await settle()
    expect(reloads).toHaveLength(1)
    expect(recovered).toEqual([1])
    expect(watchdog.reloadsSoFar()).toBe(1)
  })

  test("🔴 a window that RECOVERS is never reloaded", async () => {
    // The regression this whole module exists to avoid in the other direction: a timer that was already
    // counting down must not yank a window that came back on its own.
    const { win, reloads } = fakeWindow()
    const watchdog = createRendererWatchdog(win, { onRecovered: () => {}, onGivenUp: () => {}, graceMs: 20 })
    watchdog.arm()
    watchdog.disarm()
    await settle()
    expect(reloads).toHaveLength(0)
    expect(watchdog.reloadsSoFar()).toBe(0)
  })

  test("arming twice does not stack timers into a double reload", async () => {
    const { win, reloads } = fakeWindow()
    const watchdog = createRendererWatchdog(win, { onRecovered: () => {}, onGivenUp: () => {}, graceMs: 10 })
    watchdog.arm()
    watchdog.arm()
    watchdog.arm()
    await settle()
    expect(reloads).toHaveLength(1)
  })

  test("a window that keeps wedging is given up on, and stops being reloaded", async () => {
    const { win, reloads } = fakeWindow()
    const givenUp: number[] = []
    const watchdog = createRendererWatchdog(win, {
      onRecovered: () => {},
      onGivenUp: (attempt) => givenUp.push(attempt),
      graceMs: 10,
      maxReloads: 2,
    })
    for (let episode = 0; episode < 5; episode++) {
      watchdog.arm()
      await settle()
    }
    // The load-bearing assertion: however many times it wedges, the reload count stops at the ceiling.
    // An unbounded watchdog here is the failure mode — an unreadable flicker instead of a readable
    // freeze — so this is the number that must not grow.
    expect(reloads).toHaveLength(2)
    expect(givenUp.length).toBeGreaterThan(0)
    // Every report is the same episode count: it is reporting the SAME exhausted window, not counting
    // up. A person reading these must see "it did not recover", never an attempt tally that implies
    // progress is still being made.
    expect(new Set(givenUp)).toEqual(new Set([3]))
  })

  test("a destroyed window is never reloaded", async () => {
    const { win, reloads } = fakeWindow({ isDestroyed: () => true })
    const watchdog = createRendererWatchdog(win, { onRecovered: () => {}, onGivenUp: () => {}, graceMs: 10 })
    watchdog.arm()
    await settle()
    expect(reloads).toHaveLength(0)
  })

  test("a window being debugged is left for the person looking at it", async () => {
    const { win, reloads } = fakeWindow({ webContents: { isDestroyed: () => false, isDevToolsOpened: () => true } })
    const watchdog = createRendererWatchdog(win, { onRecovered: () => {}, onGivenUp: () => {}, graceMs: 10 })
    watchdog.arm()
    await settle()
    expect(reloads).toHaveLength(0)
  })
})
