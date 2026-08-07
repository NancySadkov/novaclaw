import { describe, expect, test } from "bun:test"
import { ComputerProposal as CP } from "./proposal"
import { ComputerCoordinates } from "./coordinates"

/**
 * S1 — the planner's wire schema.
 *
 * ⚠️ **The fixtures are the floor model's REAL failure shapes, not tidy counter-examples.** Four of
 * them are named in the design because each was actually observed somewhere in this program: `null`
 * where a field is absent (qwen, 2026-07-09), a missing `expect`, prose wrapped around the JSON, and
 * a `watch` box that excludes the very point it is supposed to be watching. A schema test written
 * against shapes I invented agrees with my mental model by construction — the same lesson
 * `verify.ts` learned from `xdotool --display`.
 *
 * Every assertion that a list is EMPTY is paired with a near-identical fixture that makes it
 * non-empty, so none of them can go vacuously green.
 */

const act = (over: Partial<CP.ProposalDraft> = {}): CP.ProposalDraft => ({
  observation: "The Master of Magic main menu, with New Game highlighted.",
  action: { kind: "click", button: "left", point: { x: 464, y: 684 } },
  expect: "The Game Options dialog is showing.",
  watch: { x: 440, y: 660, width: 60, height: 50 },
  ...over,
})

const codes = (draft: CP.ProposalDraft) => CP.structuralIssues(draft).map((i) => i.code)
const errorCodes = (draft: CP.ProposalDraft) => CP.errorsOf(CP.structuralIssues(draft)).map((i) => i.code)

// ------------------------------------------------------------------------------------------------
// Decode
// ------------------------------------------------------------------------------------------------

describe("the decode is tolerant, because the reply comes from the floor model", () => {
  test("the plain shape round-trips", () => {
    const parsed = CP.parseProposal(
      JSON.stringify({
        observation: "main menu",
        action: { kind: "click", point: { x: 464, y: 684 } },
        expect: "the options dialog appears",
        watch: { x: 400, y: 640, width: 200, height: 100 },
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.action?.kind).toBe("click")
    expect(parsed.draft.action?.point).toEqual({ x: 464, y: 684 })
    expect(errorCodes(parsed.draft)).toEqual([])
  })

  test("🔴 `null` for every absent optional — measured on qwen, and it must not be a decode failure", () => {
    // Small models write `"watch": null` rather than omitting the key. If the codec rejected that,
    // the engine would never see the draft and could only answer with a schema error.
    const parsed = CP.parseProposal(
      JSON.stringify({
        observation: null,
        action: { kind: "key", keys: "Return", point: null, button: null, text: null, amount: null },
        expect: "the highlighted program starts",
        watch: null,
        abstain: null,
        reason: null,
        claim_done: null,
        evidence: null,
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(errorCodes(parsed.draft)).toEqual([])
    // …and the null observation is a warning, not silence.
    expect(codes(parsed.draft)).toContain("missing_observation")
  })

  test("🔴 prose wrapped around the JSON, fenced", () => {
    const parsed = CP.parseProposal(
      [
        "Looking at the screen, the New Game button is the top entry in the menu list.",
        "I will click it.",
        "```json",
        '{"observation":"main menu","action":{"kind":"click","point":{"x":464,"y":684}},',
        '"expect":"the options dialog appears","watch":{"x":400,"y":640,"width":200,"height":100}}',
        "```",
        "That should get us to the next screen.",
      ].join("\n"),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.expect).toBe("the options dialog appears")
  })

  test("prose with no fence at all still yields the object", () => {
    const parsed = CP.parseProposal(
      'I cannot make out the target. {"abstain": true, "reason": "the dialog is covered by the intro overlay"}',
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.abstain).toBe(true)
    expect(errorCodes(parsed.draft)).toEqual([])
  })

  test("🔴 the FLAT shape our own `computer` tool teaches — a string action with x/y beside it", () => {
    // tool/computer.ts's Input is flat: {action:"click", x, y, button, …}. A model that has seen the
    // tool has been taught that shape by us; rejecting it would be rejecting our own documentation.
    const parsed = CP.parseProposal(
      JSON.stringify({
        observation: "main menu",
        action: "click",
        x: 464,
        y: 684,
        button: "left",
        expect: "the options dialog appears",
        region: "400,640,200,100",
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.action).toEqual({ kind: "click", button: "left", point: { x: 464, y: 684 } })
    expect(parsed.draft.watch).toEqual({ x: 400, y: 640, width: 200, height: 100 })
    expect(errorCodes(parsed.draft)).toEqual([])
  })

  test("`watch` as the tool's own \"x,y,width,height\" string, and as an array", () => {
    for (const watch of ["10,20,30,40", [10, 20, 30, 40], { x: 10, y: 20, w: 30, h: 40 }, { x: "10", y: "20", width: "30", height: "40" }]) {
      const parsed = CP.parseProposal(
        JSON.stringify({ action: { kind: "click", point: { x: 15, y: 25 } }, expect: "it opens", watch }),
      )
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.draft.watch).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    }
  })

  test("a point emitted as a two-element array", () => {
    const parsed = CP.parseProposal('{"action":{"kind":"move","point":[464,684]},"expect":"the cursor is over New Game"}')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.draft.action?.point).toEqual({ x: 464, y: 684 })
  })

  test("numbers written as strings are adopted; non-numeric strings are left to fail loudly", () => {
    const good = CP.parseProposal('{"action":{"kind":"scroll","direction":"down","amount":"3"},"expect":"the list scrolls"}')
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.draft.action?.amount).toBe(3)

    const bad = CP.parseProposal('{"action":{"kind":"scroll","direction":"down","amount":"a lot"},"expect":"x"}')
    expect(bad.ok).toBe(false)
  })

  test("🔴 `abstain` filled with prose — the field name carries the meaning, so the model writes the reason INTO it", () => {
    const parsed = CP.parseProposal('{"abstain": "I cannot see the New Game button on this screen"}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.abstain).toBe(true)
    expect(parsed.draft.reason).toBe("I cannot see the New Game button on this screen")
    expect(codes(parsed.draft)).toEqual([])
  })

  test('"true"/"false" in `abstain` stay flags and do not become reasons', () => {
    const yes = CP.parseProposal('{"abstain":"true","reason":"nothing visible"}')
    expect(yes.ok).toBe(true)
    if (yes.ok) {
      expect(yes.draft.abstain).toBe(true)
      expect(yes.draft.reason).toBe("nothing visible")
    }
    const no = CP.parseProposal('{"abstain":"false","action":{"kind":"key","keys":"Return"},"expect":"it runs"}')
    expect(no.ok).toBe(true)
    if (no.ok) expect(no.draft.abstain).toBe(false)
  })

  test("`claim_done` filled with prose puts the text in `evidence`", () => {
    const parsed = CP.parseProposal('{"claim_done": "the turn counter now reads 2"}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.claim_done).toBe(true)
    expect(parsed.draft.evidence).toBe("the turn counter now reads 2")
    expect(codes(parsed.draft)).toEqual([])
  })

  test("`expected` is accepted as an alias for `expect` — it is what jh's own Check vocabulary calls it", () => {
    const parsed = CP.parseProposal('{"action":{"kind":"key","keys":"Return"},"expected":"MAGIC.EXE starts"}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.expect).toBe("MAGIC.EXE starts")
    expect(errorCodes(parsed.draft)).not.toContain("missing_expect")
  })

  test("extra keys the schema does not know are ignored, not fatal", () => {
    const parsed = CP.parseProposal(JSON.stringify({ ...act(), confidence: 0.8, rationale: "it is the top entry" }))
    expect(parsed.ok).toBe(true)
  })

  test("a reply with no JSON at all reports WHERE and WHY, not just `failed`", () => {
    const parsed = CP.parseProposal("I think we should probably click the button in the middle of the screen.")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issue).toContain("no_json")
    expect(parsed.issue).toContain("likely cause")
  })

  test("🔴 a HALF-built rectangle is a decode failure, never a silently completed one", () => {
    // The property tool/computer.ts bought with its "x,y,width,height" string, kept here: three of
    // four fields cannot be defaulted into a region, because a wrong region reads as evidence.
    const parsed = CP.parseProposal('{"action":{"kind":"click","point":{"x":1,"y":2}},"expect":"x","watch":{"x":1,"y":2,"width":3}}')
    expect(parsed.ok).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------
// The three shapes
// ------------------------------------------------------------------------------------------------

describe("exactly one of the three legal shapes, per reply", () => {
  test("a well-formed act has no issues at all — and the check is not vacuous", () => {
    expect(CP.structuralIssues(act())).toEqual([])
    // The negative control: one field away from that fixture, and the same call reports.
    expect(errorCodes(act({ expect: null }))).toContain("missing_expect")
  })

  test("an empty object is not a proposal", () => {
    expect(errorCodes({})).toEqual(["no_proposal"])
  })

  test("`abstain` is first-class (A14.3 / G12) — a legal answer, not an error", () => {
    expect(CP.structuralIssues({ abstain: true, reason: "the target is off screen" })).toEqual([])
  })

  test("`abstain: false` is not an abstention, so it does not count as a shape", () => {
    expect(errorCodes({ abstain: false, reason: "n/a" })).toEqual(["no_proposal"])
  })

  test("`claim_done` alone is a legal proposal — G1 makes it harmless, so it need not be refused here", () => {
    expect(CP.structuralIssues({ claim_done: true, evidence: "the turn counter reads 2" })).toEqual([])
  })

  test("🔴 mixing an action with a done-claim is refused", () => {
    // A `claim_done` is judged against a frame the harness captured. Riding along with an action that
    // has not run asks for a verdict on a screen that does not exist yet.
    const issues = CP.structuralIssues(act({ claim_done: true, evidence: "done" }))
    expect(issues.map((i) => i.code)).toContain("ambiguous_shape")
    expect(issues.find((i) => i.code === "ambiguous_shape")?.detail).toBe("action + claim_done")
  })

  test("abstaining without a reason is a WARNING — repairing it would punish the behaviour we want", () => {
    const issues = CP.structuralIssues({ abstain: true })
    expect(issues.map((i) => i.code)).toEqual(["abstain_missing_reason"])
    expect(CP.errorsOf(issues)).toEqual([])
  })

  test("claiming done without evidence is a warning too", () => {
    expect(CP.errorsOf(CP.structuralIssues({ claim_done: true }))).toEqual([])
    expect(codes({ claim_done: true })).toEqual(["claim_done_missing_evidence"])
  })
})

// ------------------------------------------------------------------------------------------------
// `expect`
// ------------------------------------------------------------------------------------------------

describe("🔴 `expect` is required, because rung 2 adjudicates a PRIOR commitment", () => {
  test("absent, null and whitespace are all the same failure", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(errorCodes(act({ expect: value }))).toContain("missing_expect")
    }
    // …and the same fixture with a real sentence does not report it.
    expect(errorCodes(act({ expect: "the options dialog appears" }))).not.toContain("missing_expect")
  })

  test("the detail says why, so the repair prompt can quote a reason rather than a rule", () => {
    const issue = CP.structuralIssues(act({ expect: null })).find((i) => i.code === "missing_expect")
    expect(issue?.detail).toContain("adjudicated")
  })

  test("a missing `observation` is only a warning — it costs prompt quality, not verifiability", () => {
    const issues = CP.structuralIssues(act({ observation: null }))
    expect(CP.errorsOf(issues)).toEqual([])
    expect(issues.map((i) => i.code)).toEqual(["missing_observation"])
  })
})

// ------------------------------------------------------------------------------------------------
// The action vocabulary
// ------------------------------------------------------------------------------------------------

describe("the action vocabulary is closed, and the harness keeps its own half", () => {
  test("🔴 proposing a capture is reported by name, not silently dropped", () => {
    for (const kind of ["screenshot", "cursor"] as const) {
      const issues = CP.structuralIssues(act({ action: { kind } }))
      expect(issues.map((i) => i.code)).toContain("harness_owned_action")
      expect(issues.find((i) => i.code === "harness_owned_action")?.detail).toBe(kind)
    }
  })

  test("an invented kind names what was written", () => {
    const issues = CP.structuralIssues(act({ action: { kind: "drag" } }))
    expect(issues.find((i) => i.code === "unknown_action_kind")?.detail).toBe("drag")
  })

  test("an absent kind says `(absent)` rather than an empty string", () => {
    expect(CP.structuralIssues(act({ action: {} })).find((i) => i.code === "unknown_action_kind")?.detail).toBe("(absent)")
  })

  test("every kind in the vocabulary is accepted", () => {
    const payload: Record<string, CP.ActionDraft> = {
      move: { kind: "move", point: { x: 10, y: 10 } },
      click: { kind: "click", point: { x: 10, y: 10 } },
      double_click: { kind: "double_click", point: { x: 10, y: 10 } },
      type: { kind: "type", text: "magic" },
      key: { kind: "key", keys: "Return" },
      scroll: { kind: "scroll", direction: "down", amount: 3 },
    }
    for (const kind of CP.ACTION_KINDS) {
      const watch = CP.isPointerKind(kind) ? { x: 0, y: 0, width: 100, height: 100 } : null
      const action = payload[kind]
      expect(action).toBeDefined()
      expect(errorCodes(act({ action, watch }))).toEqual([])
    }
  })

  test("the payload a kind cannot run without is required — by PRESENCE only", () => {
    // Values (a keysym spec, a scroll bound, an empty string) belong to ComputerActions.build, which
    // is the one place that knows the tool. This checks only that the field is there to build from.
    expect(errorCodes(act({ action: { kind: "type" }, watch: null }))).toEqual(["missing_action_payload"])
    expect(errorCodes(act({ action: { kind: "key" }, watch: null }))).toEqual(["missing_action_payload"])
    expect(errorCodes(act({ action: { kind: "scroll" }, watch: null }))).toEqual([
      "missing_action_payload",
      "missing_action_payload",
    ])
    expect(errorCodes(act({ action: { kind: "type", text: "magic" }, watch: null }))).toEqual([])
  })

  test("a non-pointer action needs no watch region", () => {
    expect(errorCodes(act({ action: { kind: "key", keys: "Return" }, watch: null }))).toEqual([])
  })

  test("a non-finite point is caught before anything tries to convert it", () => {
    expect(errorCodes(act({ action: { kind: "click", point: { x: Number.NaN, y: 10 } } }))).toContain("bad_point")
    expect(errorCodes(act({ action: { kind: "click", point: { x: 464, y: 684 } } }))).not.toContain("bad_point")
  })
})

// ------------------------------------------------------------------------------------------------
// watch-contains-point (G3)
// ------------------------------------------------------------------------------------------------

describe("🔴 G3 — `watch` must contain the point being acted on", () => {
  test("the real failure shape: a box that excludes its own acted point", () => {
    const issues = CP.structuralIssues(act({ watch: { x: 0, y: 0, width: 100, height: 100 } }))
    const issue = issues.find((i) => i.code === "watch_excludes_point")
    expect(issue).toBeDefined()
    expect(issue?.detail).toBe("(464,684) is outside 0,0,100,100")
    // The negative control: move the box over the point and the same call is silent.
    expect(errorCodes(act({ watch: { x: 440, y: 660, width: 60, height: 50 } }))).toEqual([])
  })

  test("a pointer action with no watch at all", () => {
    expect(errorCodes(act({ watch: null }))).toEqual(["missing_watch"])
    expect(CP.structuralIssues(act({ watch: null })).find((i) => i.code === "missing_watch")?.detail).toContain(
      "(464,684)",
    )
  })

  test("🔴 a pointer action with no POINT is the vacuity this guard would otherwise have", () => {
    // Without this, `watch_excludes_point` has nothing to test, passes, and reports nothing — a green
    // guard that could never go red. So the missing point is itself the error.
    const issues = CP.structuralIssues(act({ action: { kind: "click" } }))
    expect(issues.map((i) => i.code)).toContain("pointer_missing_point")
    expect(issues.map((i) => i.code)).not.toContain("watch_excludes_point")
  })

  test("a point with no watch AND no point reports both, so one repair fixes both", () => {
    expect(errorCodes(act({ action: { kind: "click" }, watch: null }))).toEqual([
      "pointer_missing_point",
      "missing_watch",
    ])
  })

  test("a degenerate watch is rejected before containment is even asked", () => {
    for (const watch of [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -5 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
    ]) {
      const issues = CP.structuralIssues(act({ watch }))
      expect(issues.map((i) => i.code)).toContain("bad_watch")
      expect(issues.map((i) => i.code)).not.toContain("watch_excludes_point")
    }
  })

  test("containment is CLOSED, and the far edge is a warning rather than a rejection", () => {
    const watch = { x: 100, y: 100, width: 50, height: 50 }
    expect(CP.watchContains(watch, { x: 100, y: 100 })).toBe(true)
    expect(CP.watchContains(watch, { x: 150, y: 150 })).toBe(true)
    expect(CP.watchContains(watch, { x: 151, y: 150 })).toBe(false)
    expect(CP.watchContains(watch, { x: 99, y: 120 })).toBe(false)

    const edge = CP.structuralIssues(act({ action: { kind: "click", point: { x: 150, y: 150 } }, watch }))
    expect(CP.errorsOf(edge)).toEqual([])
    expect(edge.map((i) => i.code)).toContain("watch_point_on_edge")
    // …and one pixel in from the edge is silent.
    expect(CP.structuralIssues(act({ action: { kind: "click", point: { x: 149, y: 149 } }, watch }))).toEqual([])
  })

  test("🔴 checking containment in MODEL units is sound, because the conversion is monotone", () => {
    // This is the justification for S1 being pure at all: `px = round(norm / 1000 × dimension)` is
    // monotone non-decreasing per axis, so a point inside the box in the model's own units is still
    // inside it after conversion. If that ever stops holding, this guard starts rejecting correct
    // proposals — or worse, accepting ones whose region will not contain the acted pixel.
    const viewport = { width: 1280, height: 800 }
    const watch = { x: 440, y: 660, width: 60, height: 50 }
    const px = (p: { x: number; y: number }) => {
      const r = ComputerCoordinates.toPixels(p, "normalized-1000", viewport)
      expect(r.ok).toBe(true)
      return r.ok ? r.point : { x: -1, y: -1 }
    }
    const box = { min: px({ x: watch.x, y: watch.y }), max: px({ x: watch.x + watch.width, y: watch.y + watch.height }) }
    let inside = 0
    for (let x = 430; x <= 510; x += 1) {
      for (let y = 650; y <= 720; y += 5) {
        const point = { x, y }
        if (!CP.watchContains(watch, point)) continue
        inside++
        const p = px(point)
        expect(p.x).toBeGreaterThanOrEqual(box.min.x)
        expect(p.x).toBeLessThanOrEqual(box.max.x)
        expect(p.y).toBeGreaterThanOrEqual(box.min.y)
        expect(p.y).toBeLessThanOrEqual(box.max.y)
      }
    }
    // Non-vacuity: the sweep must actually have entered the box.
    expect(inside).toBeGreaterThan(500)
  })
})

// ------------------------------------------------------------------------------------------------
// The repair re-prompt
// ------------------------------------------------------------------------------------------------

describe("the repair re-prompt (G3 — one shot, then it costs budget)", () => {
  test("nothing to repair produces the EMPTY string, so a caller cannot send an empty complaint", () => {
    expect(CP.repairPrompt({ issues: CP.structuralIssues(act()) })).toBe("")
    expect(CP.repairPrompt({})).toBe("")
    // The negative control for that empty assertion: a real issue makes the same call non-empty.
    expect(CP.repairPrompt({ issues: CP.structuralIssues(act({ expect: null })) })).not.toBe("")
  })

  test("warnings ALONE do not trigger a repair — an abstention is not a defect", () => {
    const issues = CP.structuralIssues({ abstain: true })
    expect(CP.errorsOf(issues)).toEqual([])
    expect(CP.repairPrompt({ issues })).toBe("")
  })

  test("it names every error, and carries the warnings along for free", () => {
    const draft = act({ expect: null, observation: null, watch: { x: 0, y: 0, width: 10, height: 10 } })
    const text = CP.repairPrompt({ issues: CP.structuralIssues(draft) })
    expect(text).toContain("REJECTED")
    expect(text).toContain("every action must predict")
    expect(text).toContain("does not contain the point")
    expect(text).toContain("(464,684) is outside 0,0,10,10")
    expect(text).toContain("describe what you see")
  })

  test("it restates the contract, because the failure being repaired is usually the contract", () => {
    const text = CP.repairPrompt({ issues: CP.structuralIssues({}) })
    for (const line of CP.CONTRACT_LINES) expect(text).toContain(line)
    expect(text).toContain("abstain")
    expect(text).toContain("claim_done")
  })

  test("an unreadable reply takes the same path and carries the located parse failure", () => {
    const parsed = CP.parseProposal("no json here at all")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const text = CP.repairPrompt({ parseFailure: parsed.issue })
    expect(text).toContain("could not be read as JSON")
    expect(text).toContain("no_json")
    expect(text).toContain("Re-emit the WHOLE proposal")
  })

  test("every issue code has a message — no code renders as `undefined`", () => {
    const drafts: ReadonlyArray<CP.ProposalDraft> = [
      {},
      act({ claim_done: true, evidence: "d" }),
      act({ expect: null, observation: null }),
      act({ action: { kind: "screenshot" } }),
      act({ action: { kind: "drag" } }),
      act({ action: { kind: "click" }, watch: null }),
      act({ action: { kind: "click", point: { x: Number.NaN, y: 1 } } }),
      act({ watch: { x: 0, y: 0, width: 0, height: 1 } }),
      act({ watch: { x: 0, y: 0, width: 10, height: 10 } }),
      act({ action: { kind: "click", point: { x: 500, y: 710 } } }),
      act({ action: { kind: "scroll" }, watch: null }),
      { abstain: true },
      { claim_done: true },
    ]
    const seen = new Set<string>()
    for (const draft of drafts) {
      for (const issue of CP.structuralIssues(draft)) {
        seen.add(issue.code)
        expect(CP.describeIssue(issue)).not.toContain("undefined")
        expect(CP.describeIssue(issue).length).toBeGreaterThan(10)
      }
    }
    // Non-vacuity, and a ratchet: a new code added without a message or a fixture fails here.
    expect([...seen].sort()).toEqual(
      [
        "abstain_missing_reason",
        "ambiguous_shape",
        "bad_point",
        "bad_watch",
        "claim_done_missing_evidence",
        "harness_owned_action",
        "missing_action_payload",
        "missing_expect",
        "missing_observation",
        "missing_watch",
        "no_proposal",
        "pointer_missing_point",
        "unknown_action_kind",
        "watch_excludes_point",
        "watch_point_on_edge",
      ].sort(),
    )
  })
})
