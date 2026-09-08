export * as ComputerEvidence from "./evidence"

import { ComputerVerify } from "./verify"
import type { ComputerActions } from "./actions"

/**
 * Computer Use 2.1 / S2 — the ATTRIBUTION ladder: not *"did the screen change"* but *"did **I** do
 * this"*.
 *
 * `verify.ts` already owns the asymmetry and refuses to over-read `changed`; what it cannot do alone
 * is attribute. On the animated Master of Magic screen that gap was total — all three steps of the
 * 08-06 probe returned `inconclusive (animated)` and the loop was blind, so the outcome was read by
 * a human looking at the final frame, which is the one thing a loop cannot do.
 * This module closes it by changing the SCOPE of the question rather than
 * the question: not *"did the screen change"* but *"did the pixels **where I aimed** change, on a
 * patch that was provably still a moment ago"*.
 *
 * 🔴 **The asymmetry is inherited unchanged, and it is the whole design.** `verify.ts` earned it
 * against the real frames of the failed click:
 *
 * - **UNCHANGED is STRONG.** A watch box that is byte-identical after an action received nothing —
 *   and a screen that animates everywhere else while that box stays still makes it *stronger*, not
 *   weaker. So `no-visible-effect` fires whether or not the region animates.
 * - **CHANGED is WEAK.** It only becomes attribution when the region was measured STILL immediately
 *   beforehand. A changed box on a box that moves by itself proves nothing, and reading it as success
 *   is exactly the mistake that would have called the autolock failure a win.
 *
 * ⚠️ **Composes `ComputerVerify.sampled()` + `judge()`; it does not re-implement them.** The digest
 * decision lives in one place, so the animation flag and the comparison can never end up talking
 * about different pixels — which is the specific trap `sampled()` was built for (a region digest
 * vetoed by a whole-screen flag leaves the loop blind while looking fixed). What this module adds is
 * the ladder *around* that verdict: the capture-failure floor beneath it, the frame context beside
 * it, and the routing of the one genuinely ambiguous case to rung 2.
 *
 * **The three rungs.** Rung 1 is free and lives here; rung 2 costs
 * one adjudication call and this module only ROUTES to it (`needs-adjudication`); rung 3 is honest
 * silence (`inconclusive`), which is `verify.ts`'s existing contract — the verdict is a suspicion the
 * planner weighs, never a hard error, because clicking an already-selected item is an honest no-op.
 */

// ---------------------------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------------------------

/**
 * One capture, which either produced a digest or did not.
 *
 * 🔴 **G2 lives in this type, and it is the single most dangerous silent failure in the design.**
 * `scrot -o` overwrites ONE reused path. A capture that fails leaves the PREVIOUS frame on disk,
 * whose digest is identical to the one before it — which forges the strongest evidence the system
 * has, a `no-visible-effect`. Making a capture a tagged value rather than a bare string means a
 * failure cannot be handed in as a digest at all: the driver has to say which one it is, and the
 * forgery becomes inexpressible instead of merely discouraged.
 */
export type Capture =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly reason: string }

export const captured = (digest: string): Capture => ({ ok: true, digest })
export const captureFailed = (reason: string): Capture => ({ ok: false, reason })

export interface Input {
  readonly kind: ComputerActions.Action["kind"]
  /**
   * Two WATCH-scope captures with no action between them, taken as late as possible — after the
   * proposal and immediately before the action — so animation is measured at the moment of acting
   * rather than a minute earlier. Their second half is the `before`.
   */
  readonly watchIdlePair: readonly [Capture, Capture]
  /** The watch region after the action. */
  readonly watchAfter: Capture
  /**
   * The whole-frame idle pair. Advisory: it says whether anything a coordinate was grounded from is
   * already moving.
   */
  readonly frameIdlePair: readonly [Capture, Capture]
  /** The whole frame after the action. */
  readonly frameAfter: Capture
  /**
   * OPTIONAL second watch capture at a longer settle (§3, "two refinements, both free"). Some UIs
   * respond slowly, and a re-capture costs nothing while separating *slow* from *nothing*. When it is
   * absent the outcome says so (`settled: false`) rather than pretending the check was made.
   */
  readonly watchSettled?: Capture
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/**
 * What the rest of the screen was doing, carried on every outcome.
 *
 * ⚠️ **`known: false` is a real state and not a default of `false`.** A frame capture that failed
 * must not read as "the screen was still" — that is ruling 2 (a fault is never described falsely) in
 * its smallest possible form, and it is the direction that matters, because "not animated" is the
 * permissive reading.
 */
export type FrameContext =
  | { readonly known: true; readonly animated: boolean; readonly changed: boolean }
  | { readonly known: false; readonly reason: string }

export type Attributed = {
  readonly kind: "attributed"
  /** The change only appeared in the delayed settle capture, not immediately. */
  readonly late: boolean
  readonly verdict: ComputerVerify.Verdict
  readonly frame: FrameContext
}

export type NoVisibleEffect = {
  readonly kind: "no-visible-effect"
  /**
   * The rest of the screen moved while the watch box did not. §3's *"a screen that animates globally
   * yet is byte-identical inside the watch box clearly received nothing"*, made into a field instead
   * of a sentence. Never true when the frame is unknown.
   */
  readonly corroboratedByFrame: boolean
  /** Whether a delayed re-capture was actually taken. `false` means unchecked, not "checked and slow". */
  readonly settled: boolean
  readonly advice: string
  readonly verdict: ComputerVerify.Verdict
  readonly frame: FrameContext
}

export type NeedsAdjudication = {
  readonly kind: "needs-adjudication"
  readonly reason: string
  readonly verdict: ComputerVerify.Verdict
  readonly frame: FrameContext
}

export type Inconclusive = {
  readonly kind: "inconclusive"
  readonly reason: string
  readonly verdict: ComputerVerify.Verdict
  readonly frame: FrameContext
}

export type CaptureFailed = {
  readonly kind: "capture-failed"
  /** Which captures failed, by name, and why. */
  readonly failed: ReadonlyArray<{ readonly capture: string; readonly reason: string }>
  readonly advice: string
}

export type Attribution = Attributed | NoVisibleEffect | NeedsAdjudication | Inconclusive | CaptureFailed

const CAPTURE_ADVICE =
  "A capture the verdict depends on did not happen, so the screen was never observed. This is NOT " +
  "evidence that the action did nothing: `scrot -o` overwrites one path, so a failed capture leaves " +
  "the PREVIOUS image in place and its digest would read as an unchanged screen. Re-capture before " +
  "concluding anything."

const ADJUDICATION_REASON =
  "The watch region animates on its own, so a difference inside it carries no attribution: the " +
  "digest cannot separate the action's effect from the animation. Ask the adjudicator whether the " +
  "prediction is visible in the after-frame."

// ---------------------------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------------------------

const okDigest = (capture: Capture): string | undefined => (capture.ok ? capture.digest : undefined)

const frameContext = (pair: readonly [Capture, Capture], after: Capture): FrameContext => {
  const idleA = okDigest(pair[0])
  const idleB = okDigest(pair[1])
  const end = okDigest(after)
  if (idleA === undefined || idleB === undefined || end === undefined) {
    const missing = [
      idleA === undefined && "frameIdlePair[0]",
      idleB === undefined && "frameIdlePair[1]",
      end === undefined && "frameAfter",
    ].filter((v): v is string => typeof v === "string")
    return { known: false, reason: `not captured: ${missing.join(", ")}` }
  }
  return { known: true, animated: idleA !== idleB, changed: idleB !== end }
}

/**
 * Rung 1 of the ladder, pure. Digests in, one attribution out.
 *
 * The order below is the order of authority and it is not interchangeable:
 *
 * 1. **A failed watch capture beats everything** — G2. Without it, the strongest verdict the system
 *    can produce is also the one a failure forges for free.
 * 2. **The action's own expectation decides whether attribution is even meaningful.** A pointer
 *    `move` is `may-change` by construction (hover states legitimately change pixels, and
 *    legitimately do not), and a `screenshot`/`cursor` read is an observation — asking an adjudicator
 *    about either spends a call to learn nothing.
 * 3. **Then `verify.judge` speaks**, and this module only names what it said in attribution terms and
 *    routes the one ambiguous case upward.
 *
 * ⚠️ **The frame captures are ADVISORY and their failure is not fatal**, which is the deliberate
 * asymmetry: the watch pair IS the evidence, while the frame pair only says whether a grounded
 * coordinate has gone stale and whether the negative is corroborated. Degrading to `known: false`
 * loses a note; refusing the whole step would lose the verdict.
 */
export function attribute(input: Input): Attribution {
  const failed: Array<{ capture: string; reason: string }> = []
  for (const [name, capture] of [
    ["watchIdlePair[0]", input.watchIdlePair[0]],
    ["watchIdlePair[1]", input.watchIdlePair[1]],
    ["watchAfter", input.watchAfter],
  ] as const) {
    if (!capture.ok) failed.push({ capture: name, reason: capture.reason })
  }
  if (failed.length > 0) return { kind: "capture-failed", failed, advice: CAPTURE_ADVICE }

  const idleFirst = okDigest(input.watchIdlePair[0])
  const before = okDigest(input.watchIdlePair[1])
  const after = okDigest(input.watchAfter)
  // Unreachable — the loop above returns on any failure. Kept as a total function rather than a cast,
  // so a later edit that adds a capture cannot quietly turn a failure into a digest.
  if (idleFirst === undefined || before === undefined || after === undefined)
    return { kind: "capture-failed", failed: [{ capture: "watch", reason: "not captured" }], advice: CAPTURE_ADVICE }

  const frame = frameContext(input.frameIdlePair, input.frameAfter)
  const verdict = ComputerVerify.judge(ComputerVerify.sampled({ kind: input.kind, idle: [idleFirst, before], after }))

  const expectation = ComputerVerify.expectationFor(input.kind)
  if (expectation === "may-change") {
    return {
      kind: "inconclusive",
      reason:
        "a pointer move is not attributable: hover states legitimately change pixels and legitimately " +
        "do not, so neither outcome carries information",
      verdict,
      frame,
    }
  }
  if (expectation === "must-not-change") {
    return {
      kind: "inconclusive",
      reason:
        verdict.kind === "changed-while-observing"
          ? "an observation, and the screen moved during it — every coordinate grounded from the earlier frame is stale"
          : "an observation changes nothing by design, so there is nothing to attribute",
      verdict,
      frame,
    }
  }

  const watchAnimated = idleFirst !== before

  if (!verdict.ok && verdict.kind === "no-visible-effect") {
    // §3's first refinement: a re-capture at a longer settle separates SLOW from NOTHING, and costs
    // nothing. A late difference on a STILL region is the action arriving late; on an animating
    // region it is just the animation, so it climbs to rung 2 rather than being read as success.
    const settle = input.watchSettled
    const lateChange = settle !== undefined && settle.ok && settle.digest !== before
    if (lateChange && !watchAnimated) return { kind: "attributed", late: true, verdict, frame }
    if (lateChange) return { kind: "needs-adjudication", reason: ADJUDICATION_REASON, verdict, frame }
    return {
      kind: "no-visible-effect",
      corroboratedByFrame: frame.known && (frame.animated || frame.changed),
      settled: settle !== undefined && settle.ok,
      advice: verdict.advice,
      verdict,
      frame,
    }
  }

  if (verdict.ok && verdict.kind === "changed") return { kind: "attributed", late: false, verdict, frame }

  // `should-change` + `inconclusive` is the one case rung 1 genuinely cannot answer: the region moved
  // and it was already moving. This is what rung 2 exists for.
  return { kind: "needs-adjudication", reason: ADJUDICATION_REASON, verdict, frame }
}

