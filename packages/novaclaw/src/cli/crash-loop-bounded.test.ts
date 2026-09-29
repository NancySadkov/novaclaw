import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  FAST_CRASH_GIVEUP,
  FAST_CRASH_MS,
  HISTORY_RESET_ALIVE_MS,
  SLOW_CRASH_GIVEUP,
  initialSuperviseState,
  superviseDecision,
  type SuperviseState,
} from "./supervise"

/**
 * 🔴 A CRASH LOOP MUST REACH `giveup` — FOR EVERY SHAPE OF CRASH LOOP.
 *
 * Measured 2026-09-29 on a live instance: the server child was restarted at 01:18, 01:54 and 02:09,
 * `code 1` every time, roughly six minutes apart — and the desktop log carried
 * `[supervise] sidecar exited (code 1) - restarting in 1s` on that cycle going back to 2026-09-23.
 * The restart ladder existed, reported a `restarting` phase, and had a `gave-up` state. It could not
 * reach it. `fastCrashes` reset at `FAST_CRASH_MS` (10 s), so every six-minute life scored as a
 * clean first start and `FAST_CRASH_GIVEUP` was arithmetically unreachable for the fault that was
 * actually happening.
 *
 * The class, stated once: **a guard whose threshold is shorter than the interval it must survive
 * cannot fire, and its presence makes the failure look handled.** A `gave-up` state nobody can reach
 * is worse than none at all, because the UI is written to trust it.
 */
const MEASURED_LIFE_MS = 6 * 60_000

const run = (faults: ReadonlyArray<{ code: number; aliveMs: number }>) => {
  const actions: string[] = []
  let state: SuperviseState = initialSuperviseState
  for (const fault of faults) {
    const decision = superviseDecision(state, fault)
    actions.push(decision.action === "restart" ? `restart:${decision.delayMs}` : decision.action)
    if (decision.action !== "restart") return { actions, state, decision }
    state = decision.next
  }
  return { actions, state, decision: undefined }
}

describe("the restart ladder is reachable for the crash loop that actually happened", () => {
  test("🔴 a child that lives ~6 minutes and dies gives up, where the old policy never did", () => {
    // The measured sequence, verbatim in shape: code 1, six-minute lives, over and over.
    const faults = Array.from({ length: 20 }, () => ({ code: 1, aliveMs: MEASURED_LIFE_MS }))
    const { actions, decision } = run(faults)
    expect(decision?.action).toBe("giveup")
    // And it gives up promptly — the whole point is that a person finds out in minutes, not days.
    expect(actions.length).toBe(SLOW_CRASH_GIVEUP)
    // Every step before it was a genuine restart, so this is a bounded ladder and not an instant stop.
    expect(actions.slice(0, -1).every((action) => action.startsWith("restart:"))).toBe(true)
  })

  test("the old policy's own numbers make the giveup unreachable — the defect, replayed", () => {
    // A guard that a plausible fault sequence cannot reach is not a guard. This replays the PRE-FIX
    // arithmetic (single counter, reset at FAST_CRASH_MS, giveup at FAST_CRASH_GIVEUP) over the
    // measured fault, and shows the counter pinned at zero forever.
    let fastCrashes = 0
    for (let i = 0; i < 50; i++) {
      fastCrashes = MEASURED_LIFE_MS < FAST_CRASH_MS ? fastCrashes + 1 : 0
    }
    expect(fastCrashes).toBe(0)
    expect(fastCrashes).toBeLessThan(FAST_CRASH_GIVEUP)
    // Pre-fix, that is a permanent restart loop. Post-fix the same sequence gives up on attempt
    // SLOW_CRASH_GIVEUP, asserted above. Both halves are in this file so the claim cannot rot.
  })

  test("a boot-crash loop still gives up on the FAST ladder, with its own diagnosis", () => {
    const faults = Array.from({ length: FAST_CRASH_GIVEUP + 5 }, () => ({ code: 1, aliveMs: 100 }))
    const { actions, decision } = run(faults)
    expect(decision?.action).toBe("giveup")
    expect(actions.length).toBe(FAST_CRASH_GIVEUP)
  })

  test("a server that does real work is forgiven, so an hour-long instance is not a crash loop", () => {
    // The other half of the fix, and the reason the window is an HOUR rather than ten minutes. A
    // bounded ladder that also fires on healthy long-lived servers would be its own outage.
    const faults = Array.from({ length: 6 }, () => ({ code: 1, aliveMs: HISTORY_RESET_ALIVE_MS + 60_000 }))
    const { actions, decision } = run(faults)
    expect(decision).toBeUndefined()
    expect(actions).toHaveLength(6)
  })

  test("a genuine long run followed by one crash restarts at the BASE delay, not the cap", () => {
    // Forgiving resets the backoff too, so a server that ran an hour and then died gets the same
    // first-try patience as a fresh start rather than inheriting a stale 30-second wait.
    const climbed: SuperviseState = { fastCrashes: 0, slowCrashes: 2, backoffMs: 30_000 }
    const decision = superviseDecision(climbed, { code: 1, aliveMs: HISTORY_RESET_ALIVE_MS + 1_000 })
    if (decision.action !== "restart") throw new Error("expected restart")
    expect(decision.delayMs).toBe(1_000)
    expect(decision.next.slowCrashes).toBe(0)
  })

  test("an exit 0 is never restarted, however deep the fault history", () => {
    // A deliberate shutdown must not be fought even mid-crash-loop, or quitting would relaunch.
    for (const slowCrashes of [0, 1, 2]) {
      expect(
        superviseDecision({ fastCrashes: 0, slowCrashes, backoffMs: 30_000 }, { code: 0, aliveMs: 50 }),
      ).toEqual({ action: "stop-clean" })
    }
  })

  test("the windows are ordered so no two thresholds can disagree about what 'healthy' means", () => {
    // The original defect was two forgiveness thresholds (10 s and 60 s) pointing at the same
    // question. Now there is ONE counter window, and the shorter backoff reset touches only the delay.
    expect(HISTORY_RESET_ALIVE_MS).toBeGreaterThan(60_000)
    expect(HISTORY_RESET_ALIVE_MS).toBeGreaterThan(MEASURED_LIFE_MS)
    expect(SLOW_CRASH_GIVEUP).toBeGreaterThan(0)
    expect(SLOW_CRASH_GIVEUP).toBeLessThan(FAST_CRASH_GIVEUP)
  })
})

describe("both supervisors say which ladder gave up", () => {
  // The policy being correct is invisible if the message names only the fast ladder: an operator
  // reading "5 consecutive fast exits" after a six-minute crash loop has been told the wrong story.
  for (const [label, file] of [
    ["serve.ts", "./cmd/serve.ts"],
    ["desktop server.ts", "../../../desktop/src/main/server.ts"],
  ] as const) {
    test(`${label} names both ladders`, () => {
      // Anchored on the `note(`/`console.error(` that EMITS the message, not on a prose mention: a
      // doc comment saying "crash loop" must not satisfy a ratchet about what an operator is told.
      const source = readFileSync(new URL(file, import.meta.url), "utf8")
      // Comments stripped, because the measured context is written where the message is emitted — and
      // a comment mentioning a threshold must not be able to satisfy a ratchet about what is emitted.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
      // The template may open with a log prefix (`[supervise] crash loop — …`), so the anchor is the
      // emitted literal CONTAINING the phrase rather than one starting with it.
      // The whole CONCATENATION, not the first literal: `serve.ts` builds its message from three
      // adjacent template literals joined by `+`, so a match on one backtick-delimited chunk would
      // miss whichever constant happens to live in the next.
      const start = /(?:note|console\.error)\(\s*`[^`]{0,80}crash loop/.exec(code)
      expect(start, `the giveup message must be emitted in ${label} — a rename must fail here`).not.toBeNull()
      const emitted = code.slice(start!.index, start!.index + 900)
      expect(emitted).toContain("FAST_CRASH_GIVEUP")
      expect(emitted).toContain("SLOW_CRASH_GIVEUP")
    })
  }
})
