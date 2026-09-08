export * as ComputerPrompt from "./prompt"

import { Schema } from "effect"

import { JhExtract } from "../jh/extract"
import { ComputerLedger } from "./ledger"
import { ComputerProposal } from "./proposal"

/**
 * Computer Use — every model role in the reducer's visual protocol.
 *
 * They are built here because the thing that makes each separation safe is a property of the
 * RENDERED STRING, not of the call site:
 *
 * | builder | sees | answers |
 * |---|---|---|
 * | {@link planner} | the goal, the append-only ledger, the newest frame | one proposal |
 * | {@link grounder} | one visible label and one frame | one point; sampled three times |
 * | {@link preActionCritic} | compact history, one target-local crop, the proposed point | approve / reject |
 * | {@link adjudicator} | one prediction sentence, one closed question, one frame | `observed` / `predicted` / `checkpoint` |
 *
 * 🔴 **G5 — the adjudicator is BLIND, and that separation is the whole of rung 2.** A model shown
 * *"I clicked New Game"* and asked *"is the New Game screen showing?"* will ratify itself; a model
 * shown only a frame and a sentence has to look. So {@link adjudicator}'s input has no field for the
 * goal, the action, or the ledger — the leak is not merely discouraged, it is unrepresentable — and
 * `prompt.test.ts` asserts over the rendered system+user strings that neither appears, with the
 * planner prompt for the same fixture as the non-vacuity control.
 *
 * ⚠️ **What G5 cannot cover, named rather than hidden: the model's own `expect` sentence.** The
 * prediction is the one piece of model-authored text the adjudicator must see, and nothing stops a
 * planner writing *"after clicking New Game the options dialog appears"*. The harness leaks nothing;
 * the model may still leak its own plan into the only channel it has. `CONTRACT_LINES` pushes against
 * it (*"write what will be VISIBLE, not what you intended"*) and that is a prompt, which is not a
 * constraint on this floor model. Treat a `predicted: yes` as the WEAK half
 * of the ladder it already is — the strong direction is rung 1's unchanged region, which no wording
 * can talk its way past.
 *
 * 🔴 **G11 — exactly one image, and the prefix is byte-stable.** {@link Prompt} carries at most one
 * {@link Image}, so "helpfully" keeping the last three frames cannot be expressed without changing
 * this type; and the render order is `[stable preamble][append-only ledger][newest image][the one
 * question]`, so everything a step adds lands AFTER everything the previous step sent. vLLM
 * prefix-caches on an exact token prefix, so that ordering is what makes the run prefill the preamble
 * once instead of 25 times. ⚠️ Whether the cache spans the multimodal segment is *expected, not
 * verified* — S7's usage series is what will say.
 */

// ---------------------------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------------------------

/**
 * One screenshot, as base64 payload plus its mime type.
 *
 * ⚠️ **`data` is the bare base64 — never a `data:` URI.** `tool/computer.ts` records why: settlement
 * builds the URI, so a producer that emits one too yields
 * `data:image/png;base64,data:image/png;base64,…`. The driver (S5) is the producer here.
 */
export interface Image {
  readonly mime: string
  readonly data: string
}

/**
 * A built prompt. **At most one image**, by construction — see G11 above.
 *
 * `{system, user}` is `JhExpander.PromptPair`'s shape, deliberately: the loop is `JhEngine` applied
 * to a screen, and a driver that already knows how to send one pair can send this one.
 */
export interface Prompt {
  readonly system: string
  readonly user: string
  readonly image?: Image
}

/**
 * Prompt tokens one 1280×800 PNG costs, MEASURED 2026-08-06: a 20 KB
 * screenshot came back as 1,052 prompt tokens on `holo3.1`, and the identical question without the
 * image cost essentially nothing.
 *
 * ⚠️ It scales with the display, so a larger screen costs multiples of this — which is exactly why
 * the budget has a token counter beside its step counter (G7). It is an ESTIMATE used only until the
 * driver has a real `usage.prompt_tokens` off the response.
 */
export const IMAGE_PROMPT_TOKENS = 1052

/**
 * ~4 characters per token. Coarse on purpose: it seeds the budget counter, and the wire corrects it
 * the moment a real `usage.prompt_tokens` comes back.
 *
 * ⚠️ **The design's `P ≈ 800` for the planner preamble is an estimate it explicitly asked to have
 * MEASURED, and this is a partial answer, not the answer.** Rendering the real preamble (purpose +
 * `CONTRACT_LINES` + a one-line goal) gives **494** by this estimator — under the guess, in the
 * cheap direction. But 494 is a character count divided by four, not a tokenizer's opinion and
 * certainly not the wire's: S5's driver reads `usage.prompt_tokens` off every response and S7's live
 * step produces the first real series. **That number, not this one, goes in the Phase 2 ledger
 * line.** Whole-run arithmetic from this estimator, for scale: 25 planner calls + 25 adjudications
 * ≈ **82,700** prompt tokens against the naive loop's measured **638,625** — 7.7×, and linear.
 */
export const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4)

export const estimateTokens = (prompt: Prompt): number =>
  estimateTextTokens(prompt.system) +
  estimateTextTokens(prompt.user) +
  (prompt.image === undefined ? 0 : IMAGE_PROMPT_TOKENS)

// ---------------------------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------------------------

const PLANNER_PURPOSE = [
  "You are driving a computer screen toward a goal, one action at a time.",
  "",
  "A harness owns the horizon, not you. It takes every screenshot, executes the single action you",
  "propose, measures whether the screen actually responded, and decides when the task is finished.",
  "You never see your own history as pictures: the image below is the screen RIGHT NOW, and every",
  "earlier step is one line in the log. Propose ONE action — the next one — and nothing else.",
]

const PLANNER_QUESTION = [
  "The image is the screen as it is right now.",
  "Emit ONE proposal for the next single action, as one JSON object in the shapes above.",
]

/**
 * The planner call: purpose + vocabulary + goal in `system`, the log + question + newest frame in
 * `user`.
 *
 * 🔴 **The goal lives in `system` and the step number does NOT, so `system` is byte-identical for
 * every step of a run.** Anything that varies per step would move the cache boundary to the very
 * front of the prompt and the prefix cache would never hit.
 *
 * `note` is the one per-step addition and it is APPENDED LAST for the same reason — a repair
 * re-prompt (`ComputerProposal.repairPrompt`) or a Guard refusal is new information, and new
 * information goes after everything already sent, never in front of it.
 */
export function planner(input: {
  readonly goal: string
  readonly ledger: ComputerLedger.Ledger
  readonly image?: Image
  /** A repair re-prompt or a Guard refusal. Rendered last so the stable prefix stays stable. */
  readonly note?: string
}): Prompt {
  const system = [...PLANNER_PURPOSE, "", `GOAL: ${input.goal}`, "", ...ComputerProposal.CONTRACT_LINES].join("\n")

  // ⚠️ The header line is emitted UNCONDITIONALLY, including on step 1. A first step whose log block
  // is worded differently would move the divergence point of the cached prefix to the very first
  // line of `user`, throwing away the one segment every step of the run shares.
  const rendered = ComputerLedger.render(input.ledger)
  const log = [
    `STEP LOG (oldest first) — ${ComputerLedger.HEADER}`,
    rendered === "" ? "(no steps yet — this is the first)" : rendered,
  ]

  const user = [
    ...log,
    "",
    ...PLANNER_QUESTION,
    ...(input.note === undefined || input.note.trim() === "" ? [] : ["", input.note]),
  ].join("\n")

  return input.image === undefined ? { system, user } : { system, user, image: input.image }
}

// ---------------------------------------------------------------------------------------------
// The adjudicator
// ---------------------------------------------------------------------------------------------

/**
 * 🔴 **Every sentence here is written so the rendered string names no task and no action.** The
 * obvious phrasing — *"you are not told what was clicked"* — contains the action verb it promises to
 * withhold, and G5's test compares substrings, so it would fail against a `click` proposal. That is
 * the test working: a prompt that mentions clicking has taught the reader that a click happened.
 */
const ADJUDICATOR_PURPOSE = [
  "You are shown ONE screenshot and asked closed questions about it.",
  "",
  "You are not told what task is being performed, what was done to this screen, who did it, or what",
  "anyone expected to happen. That is deliberate — your answers are only useful if they come from",
  "looking at the image. If the image does not settle a question, answer no.",
]

/**
 * The output schema, **in this field order because generation order is causal.** `observed` is
 * emitted first, so the yes/no follows a description of the screen instead of leading it. There is
 * evidence this helps on our grounder specifically: the 08-06 probe found Holo's `reasoning` field
 * describing a screen correctly and unprompted — colours, relative positions, three named buttons —
 * on a task that only asked for a point.
 *
 * 🔴 **`checkpoint` MOVED IN FRONT OF `predicted` on 2026-08-08, and the cost of the old order was
 * measured at up to 10/10 of the checkpoint's accuracy.** The 08-08 acceptance run played the whole
 * Master of Magic oracle and scored 4/9 because `game-running` answered `no` on five consecutive
 * frames it had itself described as the game. The filed cause was the question's wording. On frozen
 * reference frames that is only true of ONE of those frames; on the others the same question,
 * asked ALONE, answers `yes` — and it is the two-answer call that destroys it:
 *
 * | frame, old `game-running` wording | checkpoint ALONE | `predicted` first (the old order) | `checkpoint` first |
 * |---|---|---|---|
 * | Game Options dialog | 7/10 · 9/10 | **0/10 · 0/10** | **7/10 · 9/10** |
 * | wizard select | 10/10 · 9/10 | **3/10 · 5/10** | **10/10 · 9/10** |
 *
 * (Two independent probes, N=10 each: `tmp/cu-adjudicator-twoquestion.json`,
 * `tmp/cu-adjudicator-order.json`.) **The reorder recovers the ask-alone baseline exactly**, so the
 * mechanism is generation order — the reader commits to one yes/no and drags the next along — and
 * not the mere presence of a second question. That makes the fix FREE: it costs no extra call,
 * where splitting the adjudication would have cost one per step.
 *
 * ⚠️ **Which answer goes first is decided by which one is LOAD-BEARING, not by taste.** `checkpoint`
 * is the run's score and the sole path to `Done` (G1). `predicted` is reported and nothing else —
 * it lands in the ledger's verdict string and changes no decision, because the attribution ladder
 * runs on digests before the adjudicator is ever asked. If `predicted` is ever wired into a
 * decision, this order has to be re-measured rather than kept.
 *
 * ⚠️ **The parser is unaffected and must stay that way** — `parseAdjudication` reads keys by name,
 * so no reply shape becomes unreadable. The order is a prompt-side lever only.
 */
const schemaLine = (withPrediction: boolean): string =>
  withPrediction
    ? '{"observed": "<one line describing this screen>", "checkpoint": "yes|no", "predicted": "yes|no"}'
    : '{"observed": "<one line describing this screen>", "checkpoint": "yes|no"}'

export interface AdjudicatorQuestion {
  readonly id: string
  readonly question: string
}

/**
 * The blind reader. **Takes a sentence, a question and a picture — there is no parameter for the
 * goal, the action, or the log, and adding one is what G5's test exists to catch.**
 *
 * Both halves are optional so the same builder serves all three uses, and the schema line adapts:
 * - **calibration** (G14): `checkpoint` only, asked against the START frame where the answer is
 *   known to be *no*. A yes means the channel is a yes-machine and the run is `Void`.
 * - **a step**: `prediction` + the next unsatisfied `checkpoint` — one call, two answers, which is
 *   how 2.2's 9-checkpoint score comes out of the same image at no extra cost.
 * - **a `claim_done`** (G1): the terminal `checkpoint` only. The model's claim is the reason we ask;
 *   it is never the answer, and it is not repeated into this prompt.
 */
export function adjudicator(input: {
  readonly prediction?: string
  readonly checkpoint?: AdjudicatorQuestion
  readonly image?: Image
}): Prompt {
  const withPrediction = input.prediction !== undefined && input.prediction.trim() !== ""
  const system = [
    ...ADJUDICATOR_PURPOSE,
    "",
    "Reply with exactly one JSON object and nothing else, with the fields in this order:",
    `  ${schemaLine(withPrediction)}`,
    "Describe what you see first, then answer. Do not explain your answers.",
  ].join("\n")

  // ⚠️ The USER block follows the schema's order, and both were swapped together. Asking in one
  // order while requiring the reply in the other is a third arm nobody measured, and it is the
  // obvious way for a later edit to half-revert this fix without anything going red.
  const parts: string[] = []
  if (input.checkpoint !== undefined) {
    parts.push(
      "QUESTION — answer from the image alone.",
      `  ${input.checkpoint.question.replace(/\s+/g, " ").trim()}`,
      '  → "checkpoint": "yes" or "no".',
    )
  }
  if (withPrediction) {
    if (parts.length > 0) parts.push("")
    parts.push(
      "STATEMENT — is this true of the image?",
      `  ${(input.prediction ?? "").replace(/\s+/g, " ").trim()}`,
      '  → "predicted": "yes" if the image shows it, "no" if it does not.',
    )
  }
  if (parts.length === 0) parts.push("QUESTION — describe what is on this screen.")

  const user = parts.join("\n")
  return input.image === undefined ? { system, user } : { system, user, image: input.image }
}

// ---------------------------------------------------------------------------------------------
// The grounder — the SPLIT call's second stage
// ---------------------------------------------------------------------------------------------

/**
 * 🔴 **The third builder, wired as the pointer step's mandatory second stage.** It originally landed
 * pure and unregistered so its measured prompt string could be pinned before the contract changed;
 * the loop now calls it only after the planner emits a compliant visible label.
 *
 * **What it is for.** §7c refused both obvious grounding levers on this substrate by measurement
 * (region crops −78 points; set-of-mark ±0 and it needs a UI detector we do not have) and named one
 * untried alternative: **split the call** — the planner chooses *what*, and a bare grounding call
 * with **no ledger** supplies *where*. Measured 2026-08-08 on the acceptance battery's last
 * unreached checkpoint, one frozen frame (the oracle replay's `in-game-map`), mechanical ground
 * truth from a gold-row profile over Master of Magic's unit panel (DONE's plate y 728..754, WAIT's
 * 758..784, **30.0 px pitch**), N=25 per cell because `temperature: 0` is not deterministic on this
 * deployment:
 *
 * | arm | DONE hit | median dy |
 * |---|---|---|
 * | the SHIPPED planner + the run's own ledger — i.e. what the loop does today | **7/25 (28%)** | +20.5 px |
 * | this builder, asked for the label alone | **25/25 (100%)** | **−0.3 px** |
 * | the same chain with the planner's own free-form phrase | 19/25 · 14/25 | +7.7 px |
 * | **the same phrase carrying a POSITIONAL clause** | **2/25** | +15.7 px |
 * | *negative control* — the same call asking for `WAIT`, one row down | **25/25 on WAIT**, dy +31.7 | — |
 *
 * ⭐ **The negative control is what makes the 25/25 mean anything.** A grounder that always answers
 * the middle of the panel would also score 25/25 on DONE; this one moves **31.7 px** — the measured
 * pitch — when asked for the row below, so it is resolving rows and not emitting a constant.
 *
 * 🔴 **`label` must be a LABEL — the control's visible text and nothing else.** That is the one
 * finding that is easy to undo by being helpful: the same bare call, same frame, same target, with
 * *"the DONE button located at the bottom right of the screen, below the unit portraits and to the
 * left of the PATROL button"* scores **2/25**, landing 16 px low — a positional clause drags the
 * point toward the described region's own edge. So the caller's job is to hand over four letters,
 * not a description, and {@link grounderLabelIssue} is the mechanical form of that.
 *
 * ⚠️ **Not a blanket claim about this panel.** The same call asking for `PATROL` — same row, one
 * column right — scored **4/25**, landing ~5 px above a 27 px plate every time. Two of the panel's
 * three tested controls are perfect and the third is not, so "the grounder is 100% here" is false;
 * what is true is that it is 100% on the two controls checkpoint 9 needs.
 *
 * ⚠️ **The cost, measured on the wire**: 1,137 prompt tokens and **412–419 ms**. Against the
 * planner's own 2,051 tokens / 2,459 ms, a split step is **+1,001 prompt tokens and ~400 ms LOWER
 * wall clock**, because stage 1 without the coordinate contract is itself shorter.
 */
const GROUNDER_SYSTEM = [
  "You locate elements in screenshots. Reply with exactly one JSON object and nothing else:",
  '  {"x": <int>, "y": <int>}',
  "x and y are the centre of the element in NORMALIZED coordinates from 0 to 1000, where x=0 is the " +
    "left edge of the image, x=1000 the right edge, y=0 the top edge and y=1000 the bottom edge.",
].join("\n")

/**
 * Words that turn a label into a description. Not a filter — the label is the model's own text and
 * silently editing it would make the prompt disagree with the ledger — but a **detectable
 * condition**, so a caller can refuse or re-ask instead of grounding a phrase measured at 2/25.
 */
const POSITIONAL_WORDS = [
  "above",
  "below",
  "beneath",
  "beside",
  "bottom",
  "corner",
  "left",
  "lower",
  "next to",
  "right",
  "top",
  "under",
  "upper",
]

/**
 * `undefined` when `label` is usable, otherwise the reason it is not.
 *
 * ⚠️ **This is a WARNING channel, deliberately, not a validator that rewrites.** The measured harm
 * is real (25/25 → 2/25) but a label containing the word "right" is not automatically a
 * description — a control can be *labelled* "Right". The caller decides; this only makes the
 * condition visible, which is the same posture `structuralIssues` takes toward a warning.
 */
export const grounderLabelIssue = (label: string): string | undefined => {
  const trimmed = label.trim()
  if (trimmed === "") return "the label is empty"
  const lower = trimmed.toLowerCase()
  const found = POSITIONAL_WORDS.filter((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower))
  if (found.length > 0) {
    return `the label reads as a description rather than a label (contains ${found.join(", ")}); a positional clause measured 2/25 where the bare label measured 25/25`
  }
  return undefined
}

/**
 * The grounding call: a control's label, a picture, and **no goal, no ledger, no prediction** — the
 * absence is the whole point, and it is unrepresentable rather than merely discouraged, exactly as
 * G5 makes the adjudicator's blindness unrepresentable.
 *
 * §7c's arm sweep is the evidence: the shipped planner prompt with **one** real ledger line took
 * grounding on the main menu from 100% to 10%, and neutral lines carrying no prose scored 10/10 —
 * so it is the ledger's *content* that pulls the model off the pixels. A builder with a `ledger`
 * parameter is one edit away from putting it back.
 */
export function grounder(input: { readonly label: string; readonly image?: Image }): Prompt {
  const system = GROUNDER_SYSTEM
  const user = [
    "This is a screenshot of a computer screen.",
    "",
    `Point to the control labelled '${input.label.trim()}'.`,
  ].join("\n")
  return input.image === undefined ? { system, user } : { system, user, image: input.image }
}

export type GroundingResult =
  | { readonly ok: true; readonly point: ComputerProposal.PointDraft; readonly repaired: boolean }
  | { readonly ok: false; readonly issue: string }

/**
 * The grounder's reply → a point in the model's own normalized space. **`coordinates.ts` converts to
 * pixels; this does not**, because the space is a declared property of the model and inferring it is
 * what `sniffSpace` exists to warn against.
 *
 * ⚠️ **The positional-`y` repair is reused, not re-derived.** This floor model omits the `"y":` KEY
 * in a large share of replies (`{"x": 863, 938}`), which is `ComputerProposal.repairPositionalY`'s
 * entire reason for existing; a second recovery here would be a second opinion about one model's
 * habits, and the weaker one.
 */
export function parseGrounding(text: string): GroundingResult {
  let extracted = JhExtract.extractJsonObject(text)
  let repaired = false
  if (!extracted.ok && extracted.failure.reason === "invalid_json") {
    const fixed = ComputerProposal.repairPositionalY(text)
    if (fixed.repairs > 0) {
      const retry = JhExtract.extractJsonObject(fixed.text)
      if (retry.ok) {
        extracted = retry
        repaired = true
      }
    }
  }
  if (!extracted.ok) return { ok: false, issue: `${extracted.failure.reason}: ${extracted.failure.detail}` }
  try {
    return { ok: true, point: Schema.decodeUnknownSync(ComputerProposal.PointDraft)(extracted.value), repaired }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, issue: msg.replace(/\s+/g, " ").trim().slice(0, 300) }
  }
}

// ---------------------------------------------------------------------------------------------
// The pre-action critic — C3's visually grounded safety gate
// ---------------------------------------------------------------------------------------------

/**
 * Check one already-grounded point against a NEW crop before the harness touches the screen.
 *
 * Unlike the blind grounder, this reader needs the compact macro-action history: its job is not to
 * find a point, but to catch a point that no longer names the intended control after the UI moved.
 * It never sees the goal or the planner's prediction, so it cannot ratify either. The harness crops
 * around the point mechanically and states its exact crop-local location. This is
 * load-bearing: a full-frame probe showed Holo ignored the numeric coordinate and approved both the
 * correct row (5/5) and a deliberately wrong row (5/5).
 */
export function preActionCritic(input: {
  readonly action: string
  readonly label: string
  readonly point: ComputerProposal.PointDraft
  readonly crop: { readonly width: number; readonly height: number; readonly x: number; readonly y: number }
  readonly ledger: ComputerLedger.Ledger
  readonly image?: Image
}): Prompt {
  const system = [
    "You are the final safety check before a computer pointer action.",
    "Inspect the CURRENT screenshot crop. The harness states the proposed pointer's exact location",
    "inside that crop. Decide only whether that point is on the centre of the",
    "visible control with the supplied label. Earlier actions are compact context, not evidence that",
    "the target is still there. If the target is absent, covered, moved, or the point lands elsewhere,",
    "reject. Reply with exactly one JSON object and nothing else:",
    '  {"approve": true|false, "reason": "short visible reason"}',
    "Judge the pixels at the stated crop-local point, not merely whether the target appears somewhere.",
  ].join("\n")
  const history = ComputerLedger.render(input.ledger)
  const user = [
    "COMPACT MACRO-ACTION HISTORY",
    history === "" ? "(nothing yet)" : `${ComputerLedger.HEADER}\n${history}`,
    "",
    `PROPOSED ACTION: ${input.action}`,
    `VISIBLE TARGET LABEL: ${input.label.trim()}`,
    `POINT METADATA: x=${input.point.x}, y=${input.point.y} (original grounding space)`,
    `POINT IN THIS ${input.crop.width}x${input.crop.height} CROP: x=${input.crop.x}, y=${input.crop.y}`,
    "",
    "Does the stated point in this crop land on the centre of that visible target?",
  ].join("\n")
  return input.image === undefined ? { system, user } : { system, user, image: input.image }
}

export type PreActionCritique =
  | { readonly ok: true; readonly approve: boolean; readonly reason: string }
  | { readonly ok: false; readonly issue: string }

/** Unreadable is a refusal, never approval; the reducer decides whether to repair or stop. */
export function parsePreActionCritique(text: string): PreActionCritique {
  const extracted = JhExtract.extractJsonObject(text)
  if (!extracted.ok) return { ok: false, issue: `${extracted.failure.reason}: ${extracted.failure.detail}` }
  const value = extracted.value as Record<string, unknown>
  if (typeof value.approve !== "boolean") return { ok: false, issue: "approve must be a boolean" }
  if (typeof value.reason !== "string" || value.reason.trim() === "")
    return { ok: false, issue: "reason must be a non-empty string" }
  return { ok: true, approve: value.approve, reason: value.reason.replace(/\s+/g, " ").trim().slice(0, 240) }
}

// ---------------------------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------------------------

export interface Adjudication {
  readonly observed: string
  /** `undefined` when the reader did not answer, or answered something that is not yes/no. */
  readonly predicted?: "yes" | "no"
  readonly checkpoint?: "yes" | "no"
}

export type AdjudicationResult =
  | { readonly ok: true; readonly reply: Adjudication }
  | { readonly ok: false; readonly issue: string }

/**
 * `"yes"` / `"no"` / a boolean / `"true"` / `"y"` — and **anything else is `undefined`, never `no`
 * and above all never `yes`.**
 *
 * ⚠️ The two unknown-readings are not symmetric. Reading an unparseable answer as `no` would silently
 * stall a run that is actually finished; reading it as `yes` would declare victory on a screen nobody
 * looked at, which is the `claim_done` failure wearing the adjudicator's hat. `undefined` is a third
 * state and both callers handle it as "not answered".
 */
const yesNo = (value: unknown): "yes" | "no" | undefined => {
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value !== "string") return undefined
  const v = value.trim().toLowerCase()
  if (v === "yes" || v === "y" || v === "true") return "yes"
  if (v === "no" || v === "n" || v === "false") return "no"
  return undefined
}

/**
 * The adjudicator's reply → an {@link Adjudication}.
 *
 * ⚠️ **`jh/extract.ts` again, reused rather than rewritten** — the same balanced-brace scanner
 * `ComputerProposal.parseProposal` uses, for the same reason: a second extractor would be a second
 * opinion about one model's habits, and the weaker one. `observed` is tolerated as absent (the model
 * answered without describing), because the answers are what the loop consumes; the loop only records
 * the description.
 */
export function parseAdjudication(text: string): AdjudicationResult {
  const extracted = JhExtract.extractJsonObject(text)
  if (!extracted.ok) {
    const f = extracted.failure
    return { ok: false, issue: `${f.reason}: ${f.detail}` }
  }
  const value = extracted.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, issue: "the reply is not a JSON object" }
  }
  const observed = "observed" in value && typeof value.observed === "string" ? value.observed : ""
  const predicted = "predicted" in value ? yesNo(value.predicted) : undefined
  const checkpoint = "checkpoint" in value ? yesNo(value.checkpoint) : undefined
  return {
    ok: true,
    reply: {
      observed,
      ...(predicted === undefined ? {} : { predicted }),
      ...(checkpoint === undefined ? {} : { checkpoint }),
    },
  }
}
