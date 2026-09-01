import { describe, expect, test } from "bun:test"
import { ComputerPrompt as CP } from "./prompt"
import { ComputerLedger } from "./ledger"
import { ComputerProposal } from "./proposal"

/**
 * S3 — the two prompt builders, and the two guards that only exist as properties of the RENDERED
 * STRING.
 *
 * 🔴 **G5 (the adjudicator sees neither the goal nor the action) and G11 (exactly one image, a stable
 * prefix, bounded growth) are both ABSENCE assertions**, which is the failure mode this repo fears
 * most: an absence assertion over a builder that renders nothing at all is green forever. So every
 * one below is paired with a control that finds the very same sentinel in the planner prompt, where
 * it belongs. If the sentinels stop being findable, the controls go red before the guards go
 * vacuously green.
 */

const GOAL = "SENTINEL_GOAL_zylophant — start a new game of Master of Magic and end turn one"
const OBSERVATION = "SENTINEL_OBSERVATION_qorvex: the main menu with four buttons"
const EXPECT = "The Game Options dialog is showing."
const CHECKPOINT = { id: "cp9", question: "Is a dialog headed 'Choose a new spell to research' visible?" }

const img = (tag: string): CP.Image => ({ mime: "image/png", data: `BASE64_${tag}_PAYLOAD` })

const entry = (n: number): ComputerLedger.Entry => ({
  n,
  observation: `${OBSERVATION} @${n}`,
  action: `click(464,684)`,
  expect: EXPECT,
  verdict: "no-visible-effect",
  checkpoint: `0/9`,
})

const ledgerOf = (n: number): ComputerLedger.Ledger => {
  let ledger = ComputerLedger.empty
  for (let i = 1; i <= n; i++) ledger = ComputerLedger.append(ledger, entry(i))
  return ledger
}

const whole = (prompt: CP.Prompt): string => `${prompt.system}\n${prompt.user}`

// ------------------------------------------------------------------------------------------------
// G5 — the adjudicator is blind
// ------------------------------------------------------------------------------------------------

describe("🔴 G5 — the adjudication prompt contains NEITHER the goal NOR the action", () => {
  const adjudication = CP.adjudicator({ prediction: EXPECT, checkpoint: CHECKPOINT, image: img("after") })
  const planning = CP.planner({ goal: GOAL, ledger: ledgerOf(3), image: img("now") })

  test("the goal string appears nowhere in the rendered adjudication prompt", () => {
    expect(whole(adjudication)).not.toContain(GOAL)
    expect(whole(adjudication)).not.toContain("SENTINEL_GOAL")
    expect(whole(adjudication)).not.toContain("Master of Magic")
    // The control: the identical sentinel IS findable where it belongs, so this is a real search.
    expect(whole(planning)).toContain(GOAL)
  })

  test("no action verb the planner can propose reaches the reader", () => {
    const text = whole(adjudication).toLowerCase()
    for (const kind of ComputerProposal.ACTION_KINDS) expect(text).not.toContain(kind)
    // The control: the planner prompt teaches every one of those verbs, so the scan finds them there.
    const plannerText = whole(planning).toLowerCase()
    for (const kind of ComputerProposal.ACTION_KINDS) expect(plannerText).toContain(kind)
  })

  test("neither the coordinates nor the step log reach the reader", () => {
    const text = whole(adjudication)
    expect(text).not.toContain("464")
    expect(text).not.toContain("684")
    expect(text).not.toContain("SENTINEL_OBSERVATION")
    expect(text).not.toContain("no-visible-effect")
    // Controls, in the prompt that is supposed to carry them: the coordinate and the verdict.
    const plan = whole(planning)
    expect(plan).toContain("464")
    expect(plan).toContain("no-visible-effect")
    // ⚠️ `SENTINEL_OBSERVATION` is deliberately NOT a control here any more. Since 2026-08-07 the
    // model's own prose is withheld from the PLANNER too (`ledger.ts`, measured), so it is absent
    // from both prompts and would be a vacuous control. The property that replaced it has its own
    // test below, with its own non-vacuity checks.
  })

  test("…and it is not blind because it is empty: the prediction and the question ARE there", () => {
    // Without this the three assertions above would pass on a builder that renders nothing.
    expect(whole(adjudication)).toContain(EXPECT)
    expect(whole(adjudication)).toContain(CHECKPOINT.question)
    expect(adjudication.image).toEqual(img("after"))
  })

  /**
   * 🔴 **This test used to pin the OPPOSITE order and the order was measured wrong on 2026-08-08.**
   * With `predicted` emitted first, the checkpoint answer collapsed — 7/10 → 0/10 on the Game
   * Options frame, 10/10 → 3/10 on the wizard-select frame, against a checkpoint-ALONE baseline of
   * the same 7/10 and 10/10. Emitting `checkpoint` first recovers the ask-alone baseline exactly
   * (`tmp/cu-adjudicator-order.json`, N=10 per cell), so generation order is causal between the two
   * ANSWERS and not only between the description and the answers.
   *
   * The load-bearing answer goes first: `checkpoint` is the run's score and the only path to `Done`,
   * while `predicted` is reported into the ledger's verdict string and decides nothing.
   */
  test("the output schema puts `observed` first, then the LOAD-BEARING answer, then `predicted`", () => {
    const system = adjudication.system
    expect(system.indexOf('"observed"')).toBeGreaterThan(-1)
    expect(system.indexOf('"observed"')).toBeLessThan(system.indexOf('"checkpoint"'))
    expect(system.indexOf('"checkpoint"')).toBeLessThan(system.indexOf('"predicted"'))
  })

  test("🔴 the USER block is asked in the SAME order as the schema requires the reply", () => {
    // Asking in one order while requiring the reply in the other is a third arm nobody measured,
    // and it is how a later edit half-reverts the fix with nothing going red.
    expect(adjudication.user.indexOf("QUESTION")).toBeLessThan(adjudication.user.indexOf("STATEMENT"))
    expect(adjudication.system.indexOf('"checkpoint"')).toBeLessThan(adjudication.system.indexOf('"predicted"'))
  })

  test("a calibration call drops `predicted` from the schema rather than asking about nothing", () => {
    const calibration = CP.adjudicator({ checkpoint: CHECKPOINT, image: img("start") })
    expect(calibration.system).not.toContain('"predicted"')
    expect(calibration.user).toContain(CHECKPOINT.question)
    expect(calibration.user).not.toContain("STATEMENT")
  })

  test("⚠️ the one leak G5 cannot close is the model's OWN prediction sentence", () => {
    // Named rather than hidden. `expect` is the only model-authored text the reader must see, and a
    // planner that writes its plan into it leaks the plan. The harness adds nothing; this pins that
    // the leak, when it happens, comes from the sentence and not from us.
    const leaky = CP.adjudicator({ prediction: "After clicking New Game the options dialog appears" })
    expect(leaky.user).toContain("clicking New Game")
    const clean = CP.adjudicator({ prediction: EXPECT, checkpoint: CHECKPOINT })
    expect(whole(clean).toLowerCase()).not.toContain("click")
  })
})

// ------------------------------------------------------------------------------------------------
// G11 — one image, a stable prefix, bounded growth
// ------------------------------------------------------------------------------------------------

describe("🔴 G11 — exactly one image, regardless of N", () => {
  test("across 25 steps every planner prompt carries exactly the newest frame", () => {
    for (let n = 1; n <= 25; n++) {
      const prompt = CP.planner({ goal: GOAL, ledger: ledgerOf(n - 1), image: img(`frame${n}`) })
      expect(prompt.image).toEqual(img(`frame${n}`))
    }
  })

  test("🔴 no EARLIER frame's payload survives anywhere in the prompt", () => {
    // This is what stops the quadratic blow-up returning the first time someone "helpfully" keeps
    // the last three frames: an older payload appearing in the rendered text would be found here.
    const text = whole(CP.planner({ goal: GOAL, ledger: ledgerOf(24), image: img("frame25") }))
    for (let n = 1; n <= 24; n++) expect(text).not.toContain(img(`frame${n}`).data)
    // Controls: the payload string is findable when it IS present, and it is never inlined as text.
    expect(img("frame1").data).toContain("BASE64")
    expect(text).not.toContain("BASE64")
    expect(text).not.toContain("data:image")
  })

  test("the image is a single optional field, so N frames are unrepresentable by type", () => {
    const prompt = CP.planner({ goal: GOAL, ledger: ledgerOf(3), image: img("only") })
    expect(Object.keys(prompt).filter((k) => k === "image")).toHaveLength(1)
    expect(CP.planner({ goal: GOAL, ledger: ledgerOf(3) }).image).toBeUndefined()
  })
})

describe("🔴 G11 — the prefix is byte-identical across steps", () => {
  const prompts = Array.from({ length: 25 }, (_, i) =>
    CP.planner({ goal: GOAL, ledger: ledgerOf(i), image: img(`frame${i + 1}`) }),
  )

  test("`system` never changes during a run", () => {
    for (const prompt of prompts) expect(prompt.system).toBe(prompts[0]!.system)
    // Control: it does change when the run changes, so this is not comparing a constant.
    expect(CP.planner({ goal: "a different goal", ledger: ledgerOf(0) }).system).not.toBe(prompts[0]!.system)
  })

  const HEADER_LINE = `STEP LOG (oldest first) — ${ComputerLedger.HEADER}`

  test("each step's `user` extends the previous one rather than rewriting it", () => {
    let shared = ""
    for (let i = 1; i < prompts.length; i++) {
      const previousLog = ComputerLedger.render(ledgerOf(i - 1))
      shared = previousLog === "" ? HEADER_LINE : `${HEADER_LINE}\n${previousLog}`
      expect(prompts[i - 1]!.user.startsWith(shared)).toBe(true)
      expect(prompts[i]!.user.startsWith(shared)).toBe(true)
    }
    // Non-vacuity: by step 25 the shared prefix is nearly the whole user block, which is the point —
    // a run prefills the preamble and the log once, not twice per step.
    expect(shared.length).toBeGreaterThan(prompts[prompts.length - 1]!.user.length * 0.8)
  })

  test("the per-step `note` is appended LAST, so it cannot move the cache boundary", () => {
    const plain = CP.planner({ goal: GOAL, ledger: ledgerOf(4), image: img("f") })
    const noted = CP.planner({ goal: GOAL, ledger: ledgerOf(4), image: img("f"), note: "REPAIR_SENTINEL" })
    expect(noted.system).toBe(plain.system)
    expect(noted.user.startsWith(plain.user)).toBe(true)
    expect(noted.user).toContain("REPAIR_SENTINEL")
  })
})

describe("🔴 G11 — growth per step is under the ratcheted ceiling, and the run stays linear", () => {
  test("each additional step adds at most one ledger line's worth of tokens", () => {
    let previous = 0
    const deltas: number[] = []
    for (let n = 0; n < 25; n++) {
      const tokens = CP.estimateTokens(CP.planner({ goal: GOAL, ledger: ledgerOf(n), image: img("f") }))
      if (n > 0) deltas.push(tokens - previous)
      previous = tokens
    }
    for (const delta of deltas) expect(delta).toBeLessThanOrEqual(ComputerLedger.LINE_TOKEN_CEILING)
    // Non-vacuity: the lines here are real, near-full ones — the ceiling is being approached.
    expect(Math.max(...deltas)).toBeGreaterThan(ComputerLedger.LINE_TOKEN_CEILING / 2)
  })

  test("🔴 25 designed steps cost a fraction of the 665,000 tokens the naive loop would", () => {
    // The measured naive figure: Σ (12,945 + 1,050·n) over 25 steps
    // is ≈665,000 prompt tokens, quadratic in n, because a settled tool result is durable.
    const naive = Array.from({ length: 25 }, (_, i) => 12_945 + 1_050 * i).reduce((a, b) => a + b, 0)
    expect(naive).toBeGreaterThan(600_000)

    let designed = 0
    for (let n = 0; n < 25; n++) {
      designed += CP.estimateTokens(CP.planner({ goal: GOAL, ledger: ledgerOf(n), image: img("f") }))
      designed += CP.estimateTokens(CP.adjudicator({ prediction: EXPECT, checkpoint: CHECKPOINT, image: img("f") }))
    }
    expect(designed).toBeLessThan(naive / 4)
  })

  test("the image dominates a step, which is why the ONE-image rule is the whole design", () => {
    const prompt = CP.planner({ goal: GOAL, ledger: ledgerOf(3), image: img("f") })
    const withoutImage = CP.estimateTokens({ system: prompt.system, user: prompt.user })
    expect(CP.estimateTokens(prompt) - withoutImage).toBe(CP.IMAGE_PROMPT_TOKENS)
    expect(CP.IMAGE_PROMPT_TOKENS).toBeGreaterThan(withoutImage / 2)
  })
})

// ------------------------------------------------------------------------------------------------
// The planner's contract
// ------------------------------------------------------------------------------------------------

describe("🔴 the planner is re-shown the MECHANICAL columns only — 10/10 vs 0/10, measured", () => {
  // The acceptance run's own six ledger lines, replayed into its own reconstructed planner prompt on
  // one frozen frame with mechanical ground truth, took the grounder from 10/10 correct menu rows to
  // **0/10** — every miss reproducing the run's `New Game → Load Game` failure. Six NEUTRAL lines
  // scored 10/10 and stripping the ledger's coordinates did not recover, so the cause is the model's
  // own recorded PROSE, not the log block and not its numbers. With the prose columns dropped the
  // same six real lines score **10/10** (measured 2026-08-07; the table is in `ledger.ts`'s note).
  const planning = CP.planner({ goal: GOAL, ledger: ledgerOf(6), image: img("now") })

  test("the model's own observation and prediction never reach the planner prompt", () => {
    expect(whole(planning)).not.toContain("SENTINEL_OBSERVATION")
    expect(whole(planning)).not.toContain(EXPECT)
  })

  test("…and it is not absent because the log is empty — the mechanical columns ARE there", () => {
    // Three non-vacuity checks, because "not found" is trivially true of an unpopulated block.
    // ① the entries the ledger was built from really carry the prose the assertion above searches for
    expect(ledgerOf(6).every((e) => e.observation.includes("SENTINEL_OBSERVATION"))).toBe(true)
    expect(ledgerOf(6).every((e) => e.expect === EXPECT)).toBe(true)
    // ② the log block is populated, down to the sixth line
    expect(whole(planning)).toContain("6 · click(464,684)")
    // ③ the columns G6/G13's planner-facing half needs did survive
    expect(whole(planning)).toContain("no-visible-effect")
    expect(whole(planning)).toContain("0/9")
  })
})

describe("the planner prompt states the contract the validator enforces", () => {
  test("it renders `CONTRACT_LINES` rather than restating them", () => {
    const system = CP.planner({ goal: GOAL, ledger: ComputerLedger.empty }).system
    for (const line of ComputerProposal.CONTRACT_LINES) expect(system).toContain(line)
  })

  test("the first step says the log is empty instead of showing a blank table", () => {
    const user = CP.planner({ goal: GOAL, ledger: ComputerLedger.empty }).user
    expect(user).toContain("no steps yet")
    expect(user).toContain(ComputerLedger.HEADER)
  })
})

// ------------------------------------------------------------------------------------------------
// Reading the adjudicator's answer
// ------------------------------------------------------------------------------------------------

describe("the adjudication reply is read with the same tolerance as a proposal", () => {
  test("the plain shape", () => {
    const parsed = CP.parseAdjudication('{"observed": "a dialog", "predicted": "yes", "checkpoint": "no"}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.reply).toEqual({ observed: "a dialog", predicted: "yes", checkpoint: "no" })
  })

  test("prose around a fenced block, and booleans instead of strings", () => {
    const parsed = CP.parseAdjudication(
      'Looking at the screen:\n```json\n{"observed": "the map", "predicted": true, "checkpoint": false}\n```\nHope that helps.',
    )
    if (!parsed.ok) throw new Error("expected a parse")
    expect(parsed.reply.predicted).toBe("yes")
    expect(parsed.reply.checkpoint).toBe("no")
  })

  test("🔴 an answer that is not yes/no is UNKNOWN — never `yes`, and never quietly `no`", () => {
    for (const value of ["maybe", "probably", "", "unclear", "1"]) {
      const parsed = CP.parseAdjudication(JSON.stringify({ observed: "x", predicted: value, checkpoint: value }))
      if (!parsed.ok) throw new Error("expected a parse")
      expect(parsed.reply.predicted).toBeUndefined()
      expect(parsed.reply.checkpoint).toBeUndefined()
    }
    // Control: the same field with a real answer does come through, so `undefined` means unanswered
    // rather than "this parser never reads that field".
    const good = CP.parseAdjudication('{"observed": "x", "checkpoint": "yes"}')
    if (!good.ok) throw new Error("expected a parse")
    expect(good.reply.checkpoint).toBe("yes")
  })

  test("a missing `observed` is tolerated — the answers are what the loop consumes", () => {
    const parsed = CP.parseAdjudication('{"checkpoint": "yes"}')
    if (!parsed.ok) throw new Error("expected a parse")
    expect(parsed.reply.observed).toBe("")
  })

  test("a reply with no JSON at all fails, and says so", () => {
    const parsed = CP.parseAdjudication("I cannot tell from this image.")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issue.length).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------------------------------------------------
// The grounder — the split call's second stage (measured, then wired 2026-08-08)
// ------------------------------------------------------------------------------------------------

/**
 * 🔴 **These pin a MEASUREMENT that lives in a string.** The split call scored 25/25 against the
 * shipped planner path's 7/25 on the acceptance battery's last unreached checkpoint — and the same
 * bare call, same frame, same target, scored **2/25** when the target phrase carried a positional
 * clause. So the two things worth guarding are the ABSENCE of the ledger from this prompt (§7c
 * measured one real ledger line taking grounding from 100% to 10%) and the label staying a label.
 */
describe("🔴 the grounding prompt is BLIND — no goal, no ledger, no prediction", () => {
  const grounding = CP.grounder({ label: "DONE", image: img("now") })
  const planning = CP.planner({ goal: GOAL, ledger: ledgerOf(3), image: img("now") })

  test("the goal appears nowhere, and the control finds it where it belongs", () => {
    expect(whole(grounding)).not.toContain(GOAL)
    expect(whole(grounding)).not.toContain("SENTINEL_GOAL")
    expect(whole(planning)).toContain(GOAL)
  })

  test("no ledger line reaches it — the lever this builder EXISTS for", () => {
    expect(whole(grounding)).not.toContain(ComputerLedger.HEADER)
    expect(whole(grounding)).not.toContain("click(464,684)")
    // Controls: both ARE findable in the planner prompt built from the same ledger.
    // ⚠️ `SENTINEL_OBSERVATION` is deliberately NOT one of them, and the first draft of this test
    // used it and went red: `ComputerLedger.render` re-shows the MECHANICAL columns only, so the
    // observation prose never reaches the planner either. The control failed, not the guard.
    expect(whole(planning)).toContain("click(464,684)")
    expect(whole(planning)).toContain(ComputerLedger.HEADER)
  })

  test("there is no parameter through which a ledger or a goal could be passed", () => {
    // A compile-time property, asserted at runtime over the rendered string: the ONLY caller-varying
    // text in the prompt is the label, so anything else that shows up came from this file.
    const a = whole(CP.grounder({ label: "DONE" }))
    const b = whole(CP.grounder({ label: "NEXT TURN" }))
    expect(a.replace("DONE", "§")).toBe(b.replace("NEXT TURN", "§"))
  })
})

describe("🔴 the rendered question is the one that was MEASURED", () => {
  test("the user block is exactly the measured two lines", () => {
    expect(CP.grounder({ label: "DONE" }).user).toBe(
      "This is a screenshot of a computer screen.\n\nPoint to the control labelled 'DONE'.",
    )
  })

  test("the answer space is stated as normalized 0–1000, which is Holo's declared space", () => {
    const system = CP.grounder({ label: "DONE" }).system
    expect(system).toContain("NORMALIZED coordinates from 0 to 1000")
    expect(system).toContain('{"x": <int>, "y": <int>}')
  })

  test("G11 — at most one image, same as every other builder here", () => {
    expect(CP.grounder({ label: "DONE" }).image).toBeUndefined()
    expect(CP.grounder({ label: "DONE", image: img("now") }).image).toEqual(img("now"))
  })
})

describe("🔴 a positional clause is DETECTED, because it measured 2/25 where the label measured 25/25", () => {
  test("a bare label is clean", () => {
    for (const label of ["DONE", "NEXT TURN", "OK", "Quit To DOS"]) {
      expect(CP.grounderLabelIssue(label)).toBeUndefined()
    }
  })

  test("the exact phrase that scored 2/25 is flagged", () => {
    const issue = CP.grounderLabelIssue(
      "the DONE button located at the bottom right of the screen, below the unit portraits and to the left of the PATROL button",
    )
    expect(issue).toBeDefined()
    expect(issue).toContain("2/25")
  })

  test("empty is its own reason, not a positional one", () => {
    expect(CP.grounderLabelIssue("   ")).toBe("the label is empty")
  })

  test("⚠️ it WARNS, it does not rewrite — the rendered label is what the caller passed", () => {
    const label = "the DONE button at the bottom right"
    expect(CP.grounderLabelIssue(label)).toBeDefined()
    expect(CP.grounder({ label }).user).toContain(label)
  })

  test("a word merely CONTAINING a position word is not a match", () => {
    for (const label of ["Copyright", "Toppings", "Underline Text", "Belowski"]) {
      expect(CP.grounderLabelIssue(label)).toBeUndefined()
    }
  })
})

describe("the grounding reply is read with the same tolerance as a proposal", () => {
  test("the plain shape", () => {
    const parsed = CP.parseGrounding('{"x": 864, "y": 928}')
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(parsed.point).toEqual({ x: 864, y: 928 })
    expect(parsed.repaired).toBe(false)
  })

  test('🔴 the floor model\'s missing-`"y"` shape is REPAIRED, not rejected', () => {
    // Measured on this batch's own replies: the planner emits `{"x": 863, 938}` often enough that
    // treating it as unreadable is a decode failure wearing a grounding failure's clothes.
    const parsed = CP.parseGrounding('{"x": 863, 938}')
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(parsed.point).toEqual({ x: 863, y: 938 })
    expect(parsed.repaired).toBe(true)
  })

  test("prose around a fenced block", () => {
    const parsed = CP.parseGrounding('Here it is:\n```json\n{"x": 864, "y": 924}\n```\n')
    if (!parsed.ok) throw new Error(parsed.issue)
    expect(parsed.point).toEqual({ x: 864, y: 924 })
  })

  test("🔴 an unreadable reply is an ISSUE, never a point — a defaulted (0,0) would click a corner", () => {
    for (const text of ["", "I cannot see it", '{"x": 864}', '{"mark": 3}']) {
      expect(CP.parseGrounding(text).ok).toBe(false)
    }
  })
})

describe("C3 — the pre-action critic is current, grounded, and history-aware", () => {
  const critique = CP.preActionCritic({
    action: 'click "DONE"',
    label: "DONE",
    point: { x: 864, y: 928 },
    crop: { width: 82, height: 51, x: 41, y: 25 },
    ledger: ledgerOf(2),
    image: img("preaction"),
  })

  test("it sees one current image, the proposed point, and compact mechanical history", () => {
    expect(critique.image).toEqual(img("preaction"))
    expect(whole(critique)).toContain("x=864, y=928")
    expect(whole(critique)).toContain("original grounding space")
    expect(whole(critique)).toContain("POINT IN THIS 82x51 CROP: x=41, y=25")
    expect(whole(critique)).toContain('click "DONE"')
    expect(whole(critique)).toContain(ComputerLedger.HEADER)
    expect(whole(critique)).toContain("no-visible-effect")
  })

  test("it cannot ratify the goal or prediction because neither reaches the builder", () => {
    expect(whole(critique)).not.toContain(GOAL)
    expect(whole(critique)).not.toContain(EXPECT)
    expect(whole(critique)).not.toContain("SENTINEL_GOAL")
  })

  test("approval is explicit; malformed and reasonless replies are unreadable", () => {
    expect(CP.parsePreActionCritique('{"approve":true,"reason":"point is centred"}')).toEqual({
      ok: true,
      approve: true,
      reason: "point is centred",
    })
    expect(CP.parsePreActionCritique('{"approve":false,"reason":"target moved"}')).toEqual({
      ok: true,
      approve: false,
      reason: "target moved",
    })
    for (const text of ["yes", '{"approve":"yes","reason":"looks fine"}', '{"approve":true}']) {
      expect(CP.parsePreActionCritique(text).ok).toBe(false)
    }
  })
})
