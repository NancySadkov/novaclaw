import { describe, expect, test } from "bun:test"
import { ComputerProposal as CP } from "./proposal"

/**
 * S1 — the planner's wire schema.
 *
 * ⚠️ **The fixtures are the floor model's REAL failure shapes, not tidy counter-examples.** Four of
 * them are named in the design because each was actually observed somewhere in this program: `null`
 * where a field is absent (qwen, 2026-07-09), a missing `expect`, prose wrapped around the JSON, and
 * planner-authored coordinates that would bypass the split grounder. A schema test written
 * against shapes I invented agrees with my mental model by construction — the same lesson
 * `verify.ts` learned from `xdotool --display`.
 *
 * Every assertion that a list is EMPTY is paired with a near-identical fixture that makes it
 * non-empty, so none of them can go vacuously green.
 */

const act = (over: Partial<CP.ProposalDraft> = {}): CP.ProposalDraft => ({
  observation: "The Master of Magic main menu, with New Game highlighted.",
  action: { kind: "click", button: "left", target: "New Game" },
  expect: "The Game Options dialog is showing.",
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
        action: { kind: "click", target: "New Game" },
        expect: "the options dialog appears",
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.action?.kind).toBe("click")
    expect(parsed.draft.action?.target).toBe("New Game")
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

  test("the old flat tool shape still decodes, but cannot bypass the split grounder", () => {
    // tool/computer.ts's Input is flat: {action:"click", x, y, button, …}. A model that has seen the
    // tool has been taught that shape by us; rejecting it would be rejecting our own documentation.
    const parsed = CP.parseProposal(
      JSON.stringify({
        observation: "main menu",
        action: "click",
        target: "New Game",
        x: 464,
        y: 684,
        button: "left",
        expect: "the options dialog appears",
        region: "400,640,200,100",
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.action).toEqual({
      kind: "click",
      target: "New Game",
      button: "left",
      point: { x: 464, y: 684 },
    })
    expect(parsed.draft.watch).toEqual({ x: 400, y: 640, width: 200, height: 100 })
    expect(errorCodes(parsed.draft)).toEqual(["planner_grounding_fields"])
  })

  test('`watch` as the tool\'s own "x,y,width,height" string, and as an array', () => {
    for (const watch of [
      "10,20,30,40",
      [10, 20, 30, 40],
      { x: 10, y: 20, w: 30, h: 40 },
      { x: "10", y: "20", width: "30", height: "40" },
    ]) {
      const parsed = CP.parseProposal(
        JSON.stringify({ action: { kind: "click", point: { x: 15, y: 25 } }, expect: "it opens", watch }),
      )
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.draft.watch).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    }
  })

  test("a point emitted as a two-element array", () => {
    const parsed = CP.parseProposal(
      '{"action":{"kind":"move","point":[464,684]},"expect":"the cursor is over New Game"}',
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.draft.action?.point).toEqual({ x: 464, y: 684 })
  })

  test("numbers written as strings are adopted; non-numeric strings are left to fail loudly", () => {
    const good = CP.parseProposal(
      '{"action":{"kind":"scroll","direction":"down","amount":"3"},"expect":"the list scrolls"}',
    )
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
    const parsed = CP.parseProposal(
      '{"action":{"kind":"click","point":{"x":1,"y":2}},"expect":"x","watch":{"x":1,"y":2,"width":3}}',
    )
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
    expect(CP.structuralIssues(act({ action: {} })).find((i) => i.code === "unknown_action_kind")?.detail).toBe(
      "(absent)",
    )
  })

  test("every kind in the vocabulary is accepted", () => {
    const payload: Record<string, CP.ActionDraft> = {
      move: { kind: "move", target: "File" },
      click: { kind: "click", target: "New Game" },
      double_click: { kind: "double_click", target: "Document" },
      type: { kind: "type", text: "magic" },
      type_submit: { kind: "type_submit", text: "magic" },
      key: { kind: "key", keys: "Return" },
      scroll: { kind: "scroll", direction: "down", amount: 3 },
    }
    for (const kind of CP.ACTION_KINDS) {
      const action = payload[kind]
      expect(action).toBeDefined()
      expect(errorCodes(act({ action }))).toEqual([])
    }
  })

  test("the payload a kind cannot run without is required — by PRESENCE only", () => {
    // Values (a keysym spec, a scroll bound, an empty string) belong to ComputerActions.build, which
    // is the one place that knows the tool. This checks only that the field is there to build from.
    expect(errorCodes(act({ action: { kind: "type" }, watch: null }))).toEqual(["missing_action_payload"])
    expect(errorCodes(act({ action: { kind: "type_submit" }, watch: null }))).toEqual(["missing_action_payload"])
    expect(errorCodes(act({ action: { kind: "key" }, watch: null }))).toEqual(["missing_action_payload"])
    expect(errorCodes(act({ action: { kind: "scroll" }, watch: null }))).toEqual([
      "missing_action_payload",
      "missing_action_payload",
    ])
    expect(errorCodes(act({ action: { kind: "type", text: "magic" }, watch: null }))).toEqual([])
    expect(errorCodes(act({ action: { kind: "type_submit", text: "magic" }, watch: null }))).toEqual([])
  })

  test("a non-pointer action needs no grounding target", () => {
    expect(errorCodes(act({ action: { kind: "key", keys: "Return" }, watch: null }))).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------
// split-grounding boundary
// ------------------------------------------------------------------------------------------------

describe("🔴 pointer grounding belongs to the blind second stage", () => {
  test("a visible label is required", () => {
    expect(errorCodes(act({ action: { kind: "click" } }))).toEqual(["pointer_missing_target"])
    expect(errorCodes(act({ action: { kind: "click", target: "New Game" } }))).toEqual([])
  })

  test("planner coordinates and watches are decoded only so the repair can reject them by name", () => {
    const point = act({ action: { kind: "click", target: "New Game", point: { x: 464, y: 684 } } })
    expect(errorCodes(point)).toEqual(["planner_grounding_fields"])
    const watch = act({ watch: { x: 440, y: 660, width: 60, height: 50 } })
    expect(errorCodes(watch)).toEqual(["planner_grounding_fields"])
    expect(CP.describeIssue(CP.structuralIssues(point)[0]!)).toContain("separate blind grounder")
  })

  test("all pointer kinds use the label contract; non-pointer actions do not", () => {
    for (const kind of CP.POINTER_KINDS) {
      expect(errorCodes(act({ action: { kind, target: "Visible Label" } }))).toEqual([])
      expect(errorCodes(act({ action: { kind } }))).toContain("pointer_missing_target")
    }
    expect(errorCodes(act({ action: { kind: "key", keys: "Return" } }))).toEqual([])
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
    expect(text).toContain("separate blind grounder")
    expect(text).toContain("do not emit coordinates or a watch region")
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
      act({ action: { kind: "click" } }),
      act({ action: { kind: "click", target: "New Game", point: { x: 500, y: 710 } } }),
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
        "claim_done_missing_evidence",
        "harness_owned_action",
        "missing_action_payload",
        "missing_expect",
        "missing_observation",
        "no_proposal",
        "planner_grounding_fields",
        "pointer_missing_target",
        "unknown_action_kind",
      ].sort(),
    )
  })
})

// ------------------------------------------------------------------------------------------------
// 🔴 The ONE textual repair — the omitted `"y":` key
// ------------------------------------------------------------------------------------------------

describe('🔴 `{"x": N, N}` — the omitted `"y":` key, recovered; everything else refused', () => {
  // MEASURED, not imagined. Over the 362 recorded replies of the §7c grounding study a sweep for
  // every bare numeric literal sitting in JSON member position found exactly ONE shape — 94
  // occurrences, all `keys=[x] bare=1` — and it accounted for 94 of the 104 replies the shipped
  // parser rejected. The coordinates inside those rejected replies were CORRECT, so the loop was
  // throwing away two thirds of its planner's good work. On the same frozen corpus the shipped
  // parser goes 149/272 → 232/272 on planner replies, and every one of the 40 that still fail is a
  // TRUNCATED reply, which stays refused.
  const real =
    '{"observation": "The main menu is displayed.", "action": {"kind": "click", "point": {"x": 623, 884}, ' +
    '"button": "left"}, "expect": "The Game Options dialog is showing.", ' +
    '"watch": {"x": 550, "y": 850, "width": 150, "height": 100}}'

  test("the real recorded shape decodes, and the whole proposal survives with it", () => {
    const parsed = CP.parseProposal(real)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.draft.action?.point).toEqual({ x: 623, y: 884 })
    // Not just the point: the reply the loop lost carried the prediction and the watch region too.
    expect(parsed.draft.expect).toBe("The Game Options dialog is showing.")
    expect(parsed.draft.watch).toEqual({ x: 550, y: 850, width: 150, height: 100 })
    expect(errorCodes(parsed.draft)).toEqual(["pointer_missing_target", "planner_grounding_fields"])
  })

  test("the recovery is NAMED in the result, never silent", () => {
    const parsed = CP.parseProposal(real)
    expect(parsed.ok && parsed.repairs).toEqual(["positional_y"])
    // Control: a well-formed reply reports no repair at all, so the field means something.
    const clean = CP.parseProposal(real.replace('"x": 623, 884', '"x": 623, "y": 884'))
    expect(clean.ok && clean.repairs).toBeUndefined()
    // …and both readings agree on the coordinate — the repair is not a different answer.
    expect(clean.ok && clean.draft.action?.point).toEqual({ x: 623, y: 884 })
  })

  test("a well-formed reply is never rewritten — the repair is unreachable unless JSON.parse failed", () => {
    // `repairPositionalY` would happily match this if it were run, so the guarantee is the CALL
    // SITE: `parseProposal` only reaches it on an `invalid_json` failure.
    const wellFormed = '{"observation": "note: {\\"x\\": 1, 2}", "abstain": true, "reason": "cannot see it"}'
    const parsed = CP.parseProposal(wellFormed)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.repairs).toBeUndefined()
    expect(parsed.draft.observation).toBe('note: {"x": 1, 2}')
  })

  describe("what it REFUSES to recover — a guess about a coordinate is the failure to avoid", () => {
    const refuses = (json: string) => {
      const parsed = CP.parseProposal(json)
      expect(parsed.ok).toBe(false)
      return parsed
    }

    test("`{623, 884}` — no `x` key, so which axis is which would be a guess", () => {
      refuses('{"action": {"kind": "click", "point": {623, 884}}, "expect": "e"}')
      expect(CP.repairPositionalY('{"point": {623, 884}}').repairs).toBe(0)
    })

    test("the object must OPEN on `x` — a lost key earlier is not this defect", () => {
      refuses('{"action": {"kind": "click", "point": {"z": 1, "x": 623, 884}}, "expect": "e"}')
      expect(CP.repairPositionalY('{"z": 1, "x": 623, 884}').repairs).toBe(0)
    })

    test("the object must CLOSE on the bare number — two bare values are not a point", () => {
      refuses('{"action": {"kind": "click", "point": {"x": 623, 884, 12}}, "expect": "e"}')
      expect(CP.repairPositionalY('{"x": 623, 884, 12}').repairs).toBe(0)
      expect(CP.repairPositionalY('{"x": 623, 884, "button": "left"}').repairs).toBe(0)
    })

    test('`{"y": 884, 623}` — the contract order is x then y, so this is not a positional y', () => {
      refuses('{"action": {"kind": "click", "point": {"y": 884, 623}}, "expect": "e"}')
      expect(CP.repairPositionalY('{"y": 884, 623}').repairs).toBe(0)
    })

    test("🔴 a TRUNCATED reply stays refused — inventing a brace would be inventing an action", () => {
      // 40 of the 40 replies the fixed parser still rejects are this: `finish_reason: length`. A
      // truncated reply is a BUDGET reading, never a capability one, and never an action.
      const truncated =
        '{"observation": "the menu", "action": {"kind": "click", "point": {"x": 623, 884}}, "expect": "the dial'
      const parsed = refuses(truncated)
      if (parsed.ok) return
      expect(parsed.issue).toContain("unbalanced")
    })

    test("🔴 it never rewrites text INSIDE a JSON string — the mis-escaped case is the real one", () => {
      // ⚠️ This test was VACUOUS in its first form and only running the mutation showed it. The
      // obvious fixture escapes the inner quotes (`{\"x\": 5, 6}`), and the raw bytes are then
      // `{\"x"` — which the anchored regex cannot match whether or not the scan tracks strings. So
      // it proved nothing about string-awareness.
      //
      // The case where it MATTERS is the reply that forgot to escape them, which is a floor-model
      // failure `jh/extract.ts` names by hand ("unterminated string"). Here the raw text really does
      // contain a literal `{"x": 5, 6}` inside model-authored prose read off an untrusted screen,
      // and rewriting it would silently edit what the screen said.
      const misescaped = '{"observation": "the panel shows {"x": 5, 6} in a tooltip", "abstain": true, "reason": "r"}'
      expect(misescaped).toContain('{"x": 5, 6}') // the raw bytes the anchored regex WOULD match
      expect(CP.repairPositionalY(misescaped).repairs).toBe(0)

      // …and the escaped form is left alone too, while the genuine malformed point beside it is
      // repaired — exactly ONE repair in a reply that contains two candidate-looking blocks.
      const escaped =
        '{"observation": "the file reads {\\"x\\": 5, 6} on screen", "action": {"kind": "click", "point": {"x": 623, 884}}, "expect": "e", "watch": {"x": 600, "y": 860, "width": 60, "height": 50}}'
      expect(CP.repairPositionalY(escaped).repairs).toBe(1)
      const parsed = CP.parseProposal(escaped)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.draft.observation).toBe('the file reads {"x": 5, 6} on screen')
      expect(parsed.draft.action?.point).toEqual({ x: 623, y: 884 })
    })
  })

  test("a positional ARRAY was already accepted and is a different thing", () => {
    // `[a, b]` is valid JSON that MEANS an ordered pair; reading it in the declared order is a
    // convention, not a recovery. It decodes with no repair recorded.
    const parsed = CP.parseProposal(
      '{"action":{"kind":"click","point":[623,884]},"expect":"e","watch":"600,860,60,50"}',
    )
    expect(parsed.ok && parsed.draft.action?.point).toEqual({ x: 623, y: 884 })
    expect(parsed.ok && parsed.repairs).toBeUndefined()
  })

  test("two malformed points in one reply are both repaired, and counted", () => {
    const two = '{"a": {"x": 1, 2}, "b": {"x": 3, 4}}'
    const repaired = CP.repairPositionalY(two)
    expect(repaired.repairs).toBe(2)
    expect(JSON.parse(repaired.text)).toEqual({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } })
  })

  test("negative and fractional coordinates survive the rewrite unrounded", () => {
    const repaired = CP.repairPositionalY('{"x": -1.5, 884.25}')
    expect(repaired.repairs).toBe(1)
    expect(JSON.parse(repaired.text)).toEqual({ x: -1.5, y: 884.25 })
  })
})

// ------------------------------------------------------------------------------------------------
// `watch` nested inside `action` — measured on the checkpoint-9 frame, 2026-08-08
// ------------------------------------------------------------------------------------------------

/**
 * 🔴 **This is a measured shape, not an imagined one.** Fifty planner replies were collected on the
 * acceptance battery's checkpoint-9 frame through the shipped `ComputerPrompt.planner`; **27 put
 * `watch` INSIDE `action`**, beside `point` — which is the more natural place, since `watch` is a
 * property of the action — and the decoder dropped it, so `structuralIssues` reported
 * `missing_watch` on **25 of 50** and the step spent its one G3 repair on shape rather than on
 * anything about the screen. Run C's log carries the same note live.
 *
 * The lift is the exact inverse of the flat-form hoist this file already documents, and it is
 * bounded the same way: it fills only what the proposal left empty.
 */
describe("legacy planner grounding fields are decoded for an actionable split-contract repair", () => {
  const nested = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      observation: "the in-game map",
      action: {
        kind: "click",
        target: "DONE",
        point: { x: 860, y: 920 },
        watch: { x: 840, y: 900, width: 80, height: 40 },
      },
      expect: "the turn ends",
      ...extra,
    })

  test("the measured nested shape is lifted, then rejected rather than silently using planner coordinates", () => {
    const parsed = CP.parseProposal(nested())
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(parsed.draft.watch).toEqual({ x: 840, y: 900, width: 80, height: 40 })
    expect(errorCodes(parsed.draft)).toEqual(["planner_grounding_fields"])
  })

  test("`region` nested on the action is the same alias it is at the top level", () => {
    const parsed = CP.parseProposal(
      JSON.stringify({
        observation: "the in-game map",
        action: { kind: "click", target: "DONE", point: { x: 860, y: 920 }, region: "840,900,80,40" },
        expect: "the turn ends",
      }),
    )
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(parsed.draft.watch).toEqual({ x: 840, y: 900, width: 80, height: 40 })
  })

  test("⚠️ an explicit TOP-LEVEL watch always wins — the lift fills, it never overwrites", () => {
    const parsed = CP.parseProposal(nested({ watch: { x: 0, y: 0, width: 1000, height: 1000 } }))
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(parsed.draft.watch).toEqual({ x: 0, y: 0, width: 1000, height: 1000 })
  })

  test("a lifted watch is still rejected as a planner-owned grounding field", () => {
    const parsed = CP.parseProposal(
      JSON.stringify({
        observation: "the in-game map",
        action: {
          kind: "click",
          target: "DONE",
          point: { x: 860, y: 920 },
          watch: { x: 0, y: 0, width: 10, height: 10 },
        },
        expect: "the turn ends",
      }),
    )
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(errorCodes(parsed.draft)).toContain("planner_grounding_fields")
  })

  test("a pointer proposal with a bare visible label is accepted", () => {
    const parsed = CP.parseProposal(
      JSON.stringify({
        observation: "the in-game map",
        action: { kind: "click", target: "DONE" },
        expect: "the turn ends",
      }),
    )
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(errorCodes(parsed.draft)).toEqual([])
  })
})
