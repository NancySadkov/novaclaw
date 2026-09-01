import { describe, expect, test } from "bun:test"
import { ComputerEvidence as CE } from "./evidence"

/**
 * S2 — the attribution ladder.
 *
 * 🔴 **The digests are MEASURED, not invented, and where they came from decides what they prove.**
 * Three sets, all from 2026-08-06:
 *
 * - `MOM_BEFORE` / `MOM_AFTER` are the real sha256 prefixes of the frames either side of the failed
 *   Master of Magic click (`verify.test.ts` pins the same two). They DIFFER — the attract mode was
 *   scrolling credits — which is why a whole-frame digest carried no signal and the loop was blind.
 * - `REGION_IDLE` is the region digest measured twice, back to back, on a static target.
 * - `FRAME_BEFORE` / `FRAME_AFTER` are the whole frame across the same interval, in which a change
 *   was made **well outside** the region.
 *
 * ⚠️ **The design cites that last measurement under its *attributed* bullet, and that is a
 * mis-citation worth not inheriting.** The probe changed the screen OUTSIDE the watch box on purpose
 * (see `verify.ts`'s own module note), so what it measured is region
 * determinism plus locality: the region stayed byte-identical while the frame moved. In this
 * module's vocabulary that is `no-visible-effect` with the frame CORROBORATING it — the strongest
 * negative the system can produce — not an attribution. It is pinned below as such. The positive
 * case has no measured after-digest, so its after-value is marked synthetic rather than dressed up.
 */

const MOM_BEFORE = "6e52faf7b57c62d6"
const MOM_AFTER = "aa5a00ee55c3bb6f"
const REGION_IDLE = "84624392"
const FRAME_BEFORE = "a34d5244"
const FRAME_AFTER = "dc5020c7"
/** SYNTHETIC — no region-after digest was captured on 08-06; only its equality behaviour is measured. */
const REGION_CHANGED = "synthetic:region-after"

const ok = CE.captured
const bad = CE.captureFailed

/** The 08-06 substrate probe, as the loop would hand it in: quiet region, moving frame. */
const probe = (over: Partial<CE.Input> = {}): CE.Input => ({
  kind: "click",
  watchIdlePair: [ok(REGION_IDLE), ok(REGION_IDLE)],
  watchAfter: ok(REGION_IDLE),
  frameIdlePair: [ok(FRAME_BEFORE), ok(FRAME_BEFORE)],
  frameAfter: ok(FRAME_AFTER),
  ...over,
})

// ------------------------------------------------------------------------------------------------
// G2 — the capture floor
// ------------------------------------------------------------------------------------------------

describe("🔴 G2 — a failed capture beats every other reading", () => {
  test("a failed after-capture is NOT a no-visible-effect, even though the digests would match", () => {
    // This is the forgery the guard exists for: `scrot -o` overwrites one path, so a failed capture
    // leaves the PREVIOUS image and its digest reads as an unchanged screen — manufacturing the
    // strongest evidence the system has.
    const result = CE.attribute(probe({ watchAfter: bad("scrot exited 1") }))
    expect(result.kind).toBe("capture-failed")
    // The negative control: the identical input with a real capture is exactly the verdict the
    // failure would have forged, so this test could not be green by accident.
    expect(CE.attribute(probe()).kind).toBe("no-visible-effect")
  })

  test("either idle capture failing is fatal too, and the failures are named", () => {
    const result = CE.attribute(
      probe({ watchIdlePair: [bad("no such file"), ok(REGION_IDLE)], watchAfter: bad("timed out") }),
    )
    expect(result.kind).toBe("capture-failed")
    if (result.kind !== "capture-failed") return
    expect(result.failed.map((f) => f.capture)).toEqual(["watchIdlePair[0]", "watchAfter"])
    expect(result.failed[0]?.reason).toBe("no such file")
  })

  test("the advice says why an unchanged digest is not evidence here", () => {
    const result = CE.attribute(probe({ watchAfter: bad("boom") }))
    if (result.kind !== "capture-failed") throw new Error("expected capture-failed")
    expect(result.advice).toContain("scrot -o")
    expect(result.advice).toContain("NOT")
  })

  test("a failed FRAME capture is advisory only — the watch verdict survives, degraded", () => {
    // Deliberate asymmetry: the watch pair IS the evidence; the frame pair only says whether a
    // grounded coordinate has gone stale. Refusing the step would lose the verdict to lose a note.
    const result = CE.attribute(probe({ frameAfter: bad("scrot exited 1") }))
    expect(result.kind).toBe("no-visible-effect")
    if (result.kind !== "no-visible-effect") return
    expect(result.frame.known).toBe(false)
    if (result.frame.known) return
    expect(result.frame.reason).toContain("frameAfter")
  })

  test("🔴 an unknown frame never reads as `not animated` — the permissive direction is refused", () => {
    const result = CE.attribute(probe({ frameIdlePair: [bad("x"), bad("y")], frameAfter: bad("z") }))
    if (result.kind !== "no-visible-effect") throw new Error("expected no-visible-effect")
    // `known: false` is the whole assertion: `FrameContext` carries `animated` only on the known
    // arm, so an unknown frame cannot read as animated — the type makes the permissive direction
    // unrepresentable rather than merely untaken.
    expect(result.frame.known).toBe(false)
    expect(result.corroboratedByFrame).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------
// Rung 1 — the measured cases
// ------------------------------------------------------------------------------------------------

describe("rung 1 on the REAL substrate digests", () => {
  test("🔴 the 08-06 probe: a quiet region while the frame moves is the STRONGEST negative", () => {
    const result = CE.attribute(probe())
    expect(result.kind).toBe("no-visible-effect")
    if (result.kind !== "no-visible-effect") return
    expect(result.corroboratedByFrame).toBe(true)
    expect(result.frame).toEqual({ known: true, animated: false, changed: true })
    expect(result.advice).toContain("autolock")
    expect(result.settled).toBe(false)
  })

  test("…and it is corroboration, not a constant: a still frame does not corroborate", () => {
    const result = CE.attribute(probe({ frameAfter: ok(FRAME_BEFORE) }))
    if (result.kind !== "no-visible-effect") throw new Error("expected no-visible-effect")
    expect(result.corroboratedByFrame).toBe(false)
  })

  test("a still region that CHANGED is attributed", () => {
    const result = CE.attribute(probe({ watchAfter: ok(REGION_CHANGED) }))
    expect(result.kind).toBe("attributed")
    if (result.kind !== "attributed") return
    expect(result.late).toBe(false)
    expect(result.verdict.kind).toBe("changed")
  })

  test("🔴 the same change on a region that was already MOVING is not attributed — changed is WEAK", () => {
    const result = CE.attribute(
      probe({ watchIdlePair: [ok(MOM_BEFORE), ok(MOM_AFTER)], watchAfter: ok(REGION_CHANGED) }),
    )
    expect(result.kind).toBe("needs-adjudication")
    if (result.kind !== "needs-adjudication") return
    expect(result.reason).toContain("animates")
    // The negative control for the pair: idle-stable, same after digest, and it IS attributed.
    expect(
      CE.attribute(probe({ watchIdlePair: [ok(MOM_AFTER), ok(MOM_AFTER)], watchAfter: ok(REGION_CHANGED) })).kind,
    ).toBe("attributed")
  })

  test("🔴 UNCHANGED convicts whether or not the region animates — the asymmetry, inherited", () => {
    // verify.ts's law, restated at this layer: a screen that moves by itself yet is byte-identical
    // inside the watch box clearly received nothing.
    for (const idle of [
      [ok(REGION_IDLE), ok(REGION_IDLE)],
      [ok(MOM_BEFORE), ok(REGION_IDLE)],
    ] as const) {
      const result = CE.attribute(probe({ watchIdlePair: idle }))
      expect(result.kind).toBe("no-visible-effect")
    }
  })

  test("the real MoM frames at FRAME scope: animated, so the grounding is already stale", () => {
    const result = CE.attribute(probe({ frameIdlePair: [ok(MOM_BEFORE), ok(MOM_AFTER)], frameAfter: ok(MOM_AFTER) }))
    if (result.kind !== "no-visible-effect") throw new Error("expected no-visible-effect")
    expect(result.frame).toEqual({ known: true, animated: true, changed: false })
    // …and the watch box being quiet still convicts, which is exactly the signal the 08-06 loop
    // did not have when all three of its steps came back `inconclusive (animated)`.
    expect(result.corroboratedByFrame).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------
// The settle refinement (§3)
// ------------------------------------------------------------------------------------------------

describe("the delayed re-capture separates SLOW from NOTHING", () => {
  test("a late change on a STILL region is the action arriving late", () => {
    const result = CE.attribute(probe({ watchSettled: ok(REGION_CHANGED) }))
    expect(result.kind).toBe("attributed")
    if (result.kind === "attributed") expect(result.late).toBe(true)
  })

  test("🔴 a late change on an ANIMATING region is just the animation, and climbs to rung 2", () => {
    const result = CE.attribute(
      probe({ watchIdlePair: [ok(MOM_BEFORE), ok(REGION_IDLE)], watchSettled: ok(REGION_CHANGED) }),
    )
    expect(result.kind).toBe("needs-adjudication")
  })

  test("a settle capture identical to `before` confirms the negative, and says it was checked", () => {
    const result = CE.attribute(probe({ watchSettled: ok(REGION_IDLE) }))
    expect(result.kind).toBe("no-visible-effect")
    if (result.kind === "no-visible-effect") expect(result.settled).toBe(true)
  })

  test("🔴 a FAILED settle capture reads as unchecked, never as `checked and still nothing`", () => {
    const result = CE.attribute(probe({ watchSettled: bad("scrot exited 1") }))
    expect(result.kind).toBe("no-visible-effect")
    if (result.kind === "no-visible-effect") expect(result.settled).toBe(false)
  })

  test("no settle capture at all is reported as unchecked, not as checked", () => {
    const result = CE.attribute(probe())
    if (result.kind === "no-visible-effect") expect(result.settled).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------
// Kinds for which attribution is meaningless
// ------------------------------------------------------------------------------------------------

describe("attribution is only defined for actions that SHOULD change the screen", () => {
  test("a pointer move concludes nothing either way, and never spends an adjudication call", () => {
    for (const after of [ok(REGION_IDLE), ok(REGION_CHANGED)]) {
      const result = CE.attribute(probe({ kind: "move", watchAfter: after }))
      expect(result.kind).toBe("inconclusive")
      if (result.kind === "inconclusive") expect(result.reason).toContain("hover")
    }
  })

  test("an observation is not an action", () => {
    for (const kind of ["screenshot", "cursor"] as const) {
      const result = CE.attribute(probe({ kind }))
      expect(result.kind).toBe("inconclusive")
    }
  })

  test("an observation during which the screen moved says the coordinates are stale", () => {
    const result = CE.attribute(probe({ kind: "screenshot", watchAfter: ok(REGION_CHANGED) }))
    expect(result.kind).toBe("inconclusive")
    if (result.kind === "inconclusive") expect(result.reason).toContain("stale")
  })

  test("every input kind is answered — no hole in the ladder", () => {
    const kinds = [
      "screenshot",
      "cursor",
      "move",
      "click",
      "double_click",
      "type",
      "type_submit",
      "key",
      "scroll",
    ] as const
    for (const kind of kinds) {
      for (const after of [ok(REGION_IDLE), ok(REGION_CHANGED)]) {
        const result = CE.attribute(probe({ kind, watchAfter: after }))
        expect(result.kind).toBeDefined()
        expect(result.kind).not.toBe("capture-failed")
      }
    }
  })

  test("every non-capture-failure outcome carries the verdict it was derived from", () => {
    // The composition is visible rather than hidden: the ledger can print what `verify.ts` said.
    const cases: ReadonlyArray<CE.Input> = [
      probe(),
      probe({ watchAfter: ok(REGION_CHANGED) }),
      probe({ kind: "move" }),
      probe({ kind: "screenshot" }),
      probe({ watchIdlePair: [ok(MOM_BEFORE), ok(MOM_AFTER)], watchAfter: ok(REGION_CHANGED) }),
    ]
    const seen = new Set<string>()
    for (const input of cases) {
      const result = CE.attribute(input)
      if (result.kind === "capture-failed") throw new Error("unexpected capture failure")
      seen.add(result.kind)
      expect(result.verdict.kind).toBeDefined()
    }
    // Non-vacuity: the five fixtures really do reach four distinct outcomes.
    expect([...seen].sort()).toEqual(["attributed", "inconclusive", "needs-adjudication", "no-visible-effect"])
  })
})
