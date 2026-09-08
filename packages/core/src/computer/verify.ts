export * as ComputerVerify from "./verify"

import type { ComputerActions } from "./actions"

/**
 * Did the action actually DO anything? — the half of P3's loop that the substrate run proved is
 * load-bearing rather than a nicety.
 *
 * 🔴 **The measurement this exists for (2026-08-06).** Driving Master of
 * Magic in the substrate, a click on a correctly-grounded menu item did nothing. DOSBox ships
 * `autolock=true`, so its first click CAPTURES the mouse and switches to relative motion; after that
 * `xdotool` moved the X pointer exactly where told — `getmouselocation` confirmed the coordinates —
 * while the game's own cursor sat ~250 px away. **Every diagnostic was healthy:** the grounder was
 * right, the pointer went where instructed, the process was alive, the command exited 0. The only
 * evidence anything was wrong was that the screen did not change.
 *
 * So a loop that checks "did my click command succeed" is blind to an entire class of failure, and it
 * is the class most likely to occur — every mouse-capture, focus, modal-overlay and
 * wrong-window problem lands here. **The screen is the only witness.**
 *
 * ⚠️ **This module decides; it does not capture.** The caller hashes two screenshots and passes the
 * digests. That keeps the decision pure and testable, and keeps image handling — which needs a
 * decoder we do not have — out of the kernel.
 *
 * 🔴 **THE EVIDENCE IS ASYMMETRIC, and this was nearly got wrong.** An unchanged screen is STRONG
 * evidence nothing happened. A changed screen is WEAK evidence that the action did it — anything
 * animating (an attract loop, a video, a spinner, a clock) changes pixels on its own. Measured
 * against the real frames from the failed Master of Magic click: the before/after digests DIFFER,
 * because the game's attract mode was scrolling credits, so a naive "changed ⇒ it worked" would have
 * called that failure a success. **The very case this module exists for would have passed.**
 *
 * So the caller must tell us whether the screen is animated — sample twice with NO action between —
 * and a "should-change" action on an animated screen concludes NOTHING rather than confirming.
 *
 * 🔴 **And that guard cost the loop its only evidence, which is what `region` is for.** Against Master
 * of Magic the attract loop animates continuously, so EVERY step came back `inconclusive` and P3 could
 * not verify a single one. The escape is to stop comparing whole frames: `ComputerActions` can capture
 * a REGION (`scrot -a`), and a region around the acted-on point is unaffected by animation elsewhere.
 * Measured in the substrate on 2026-08-06 — static target inside the region, change made outside it:
 * the region digest was byte-identical across both captures (`84624392` twice) while the full frame
 * changed (`a34d5244` → `dc5020c7`). Two back-to-back captures of an unchanged region also matched, so
 * the capture is deterministic and digest equality remains the test.
 *
 * ⚠️ **The trap that creates: `animated` must be measured on the SAME pixels being compared.** A region
 * comparison paired with a whole-screen animation flag is strictly worse than no region at all — the
 * region gives a clean answer and the flag then vetoes it, so the loop stays blind while looking fixed.
 * `sampled()` below exists so the flag is DERIVED from captures the caller already has at one scope,
 * rather than asserted; prefer it to setting `animated` by hand.
 */

/** What a given action is expected to do to the screen. */
export type Expectation =
  /** An observation. The screen must NOT change, or something else is driving it. */
  | "must-not-change"
  /** A pointer move: hover states legitimately change pixels, and legitimately do not. */
  | "may-change"
  /** An input action. Something should visibly happen — see the note above for why this matters. */
  | "should-change"

/**
 * ⚠️ **`should-change`, deliberately, and not `must-change`.** Plenty of honest inputs change nothing:
 * clicking an already-selected item, typing into a field that ignores the key, scrolling a list that
 * is already at the end. Treating those as failures would make the loop abandon correct work. The
 * verdict below therefore reports a *suspicion* the planner weighs, never a hard error — the loop
 * should re-look, or try a different target, not crash.
 */
export const expectationFor = (kind: ComputerActions.Action["kind"]): Expectation => {
  switch (kind) {
    case "screenshot":
    case "cursor":
      return "must-not-change"
    case "move":
    case "copy_text":
      return "may-change"
    case "click":
    case "double_click":
    case "type":
    case "type_submit":
    case "key":
    case "scroll":
      return "should-change"
  }
}

export interface Observation {
  readonly kind: ComputerActions.Action["kind"]
  /** Digest of the screen BEFORE the action. */
  readonly before: string
  /** Digest of the screen AFTER it. */
  readonly after: string
  /**
   * Does this screen change on its own? Sample two captures with NO action between them; if they
   * differ, pass `true`.
   *
   * ⚠️ **Omitting it is treated as "not animated", which is the OPTIMISTIC reading** — so a caller
   * that never measures gets the naive behaviour and its false confirmations. Measure it once per
   * screen, cheaply, and re-measure when the screen changes character.
   */
  readonly animated?: boolean
}

/**
 * Build an `Observation` from the four captures a careful loop already takes, deriving `animated`
 * instead of asserting it.
 *
 * The order is the one the loop runs in: two idle captures with NO action between them (that pair IS
 * the animation measurement), then the action, then the after capture. `idle[1]` doubles as `before`,
 * so there is no fourth capture and no window for the screen to change between measuring and acting.
 *
 * 🔴 **Why this exists rather than a doc line saying "use the same scope".** All three digests come
 * from one call site, so they are captured the same way — whole-screen or the same region — and the
 * mismatch that makes a region comparison useless (region digests judged against a whole-screen
 * animation flag) cannot be expressed. Setting `animated` by hand still works and is still supported;
 * it is just the form where nothing checks that the two measurements are about the same pixels.
 */
export const sampled = (input: {
  readonly kind: ComputerActions.Action["kind"]
  /** Two captures taken with no action between them, in order. */
  readonly idle: readonly [string, string]
  /** The capture taken after the action. */
  readonly after: string
}): Observation => ({
  kind: input.kind,
  before: input.idle[1],
  after: input.after,
  animated: input.idle[0] !== input.idle[1],
})

export type Verdict =
  /**
   * The screen changed on a still screen, so the action plausibly caused it.
   *
   * ⚠️ Still only PLAUSIBLY: this says the pixels moved, not that they moved for the reason we asked.
   * It is the best available signal, not a proof.
   */
  | { readonly ok: true; readonly kind: "changed" }
  /** Nothing changed and nothing should have — an observation behaved. */
  | { readonly ok: true; readonly kind: "stable" }
  /** A move: either outcome is legitimate, so there is nothing to conclude. */
  | { readonly ok: true; readonly kind: "inconclusive" }
  /**
   * The action ran cleanly and the screen is byte-identical. **The autolock signature.** Not proof of
   * failure — see `should-change` — but the single most informative thing the loop can know.
   */
  | { readonly ok: false; readonly kind: "no-visible-effect"; readonly advice: string }
  /**
   * The screen moved during an OBSERVATION. Something other than us is driving it: an animation, a
   * video, a second agent, a timer. Worth saying, because it makes every subsequent grounding stale.
   */
  | { readonly ok: false; readonly kind: "changed-while-observing"; readonly advice: string }

/**
 * ⚠️ **Advice, not blame.** The loop reads this; the wording exists so a planner has somewhere to go
 * rather than retrying the identical click forever. The first line names the measured cause because
 * it is by far the most common one and the hardest to guess from the symptom.
 */
const NO_EFFECT_ADVICE =
  "The command ran and the screen did not change. Before retrying the same point, check that the " +
  "target application is not capturing the pointer (DOSBox's `autolock` does this: the host pointer " +
  "moves correctly while the application's own cursor does not follow), that the right window has " +
  "focus, and that nothing is overlaying the target. Re-screenshot and re-ground rather than " +
  "repeating the click."

const OBSERVING_ADVICE =
  "The screen changed while only observing, so something other than this agent is driving it — an " +
  "animation, a video, a timer, or another session. Any coordinate grounded from the earlier frame " +
  "is already stale; ground again from the newest capture."

/**
 * Judge one action against what the screen did.
 *
 * ⚠️ **Digest equality is the test, so the capture must be deterministic for a static screen.** `scrot`
 * without `-p` does NOT draw the cursor, which is what makes this usable at all: a pure pointer move
 * leaves the image byte-identical. If a caller ever enables cursor capture, every move starts
 * reporting a change and this signal quietly inverts from useful to noise.
 */
export const judge = (observation: Observation): Verdict => {
  const changed = observation.before !== observation.after
  switch (expectationFor(observation.kind)) {
    case "must-not-change":
      // An animated screen is EXPECTED to move during an observation, so it is not a finding there.
      if (changed)
        return observation.animated
          ? { ok: true, kind: "inconclusive" }
          : { ok: false, kind: "changed-while-observing", advice: OBSERVING_ADVICE }
      return { ok: true, kind: "stable" }
    case "may-change":
      return { ok: true, kind: "inconclusive" }
    case "should-change": {
      // On an animated screen a difference proves nothing, so refuse to read it as success. The
      // UNCHANGED branch still fires: a screen that animates on its own and is byte-identical after
      // an action is even stronger evidence that nothing happened.
      if (changed) return observation.animated ? { ok: true, kind: "inconclusive" } : { ok: true, kind: "changed" }
      return { ok: false, kind: "no-visible-effect", advice: NO_EFFECT_ADVICE }
    }
  }
}
