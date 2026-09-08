export * as ComputerLoop from "./loop"

import { ComputerActions } from "./actions"
import { ComputerCoordinates } from "./coordinates"
import { ComputerEvidence } from "./evidence"
import { ComputerGroundingConsensus } from "./grounding-consensus"
import { ComputerLedger } from "./ledger"
import { ComputerPrompt } from "./prompt"
import { ComputerProposal } from "./proposal"

/**
 * Computer Use 2.1 / S4 — the loop itself: a PURE REDUCER, `JhEngine`'s shape applied to a screen.
 *
 * ```
 * next(state, event) -> { state, command }
 * ```
 *
 * **No I/O, no Effect, no clock in here.** The driver (S5) interprets commands, performs captures and
 * model calls, and feeds the results back as events. That is the same seam `jh/engine.ts` is built on
 * — injected `introspect`/`correct`, driven in-process by `tests/jh-pi-smoke.ts` — and it is what buys
 * the property this program most needs: **the autolock class becomes a unit test instead of a
 * container.** Two `no-visible-effect` verdicts on different targets are three lines of scripted
 * events here; live they were a day in a Docker image on the Spark.
 *
 * 🔴 **`Done` is reachable through exactly ONE code path and it is not the model's.** The design
 * states it as a law and this file is where the law is mechanical:
 *
 * > `Done` is reachable only when a harness-invoked adjudication of the TERMINAL checkpoint answers
 * > affirmatively on a frame the harness captured. The model's `claim_done` is an input to that check
 * > and never a substitute for it. A task supplied with no terminal checkpoint can never reach
 * > `Done` — it terminates `Blocked(done-unverifiable)` and says so.
 *
 * ⚠️ **the one-level lookahead (`lookahead-checkpoint` below) widened WHICH frame can carry that answer and nothing else about
 * the law.** When the terminal checkpoint is the lookahead target it is asked by the harness, on a
 * harness-captured frame, and gated by the one-re-ask confirmation gate (`confirm-checkpoint` below) exactly like every other
 * award — the evidence standard is unchanged; only the requirement that the answer arrive on the one
 * frame where the ratchet happened to be pointing at it is gone.
 *
 * `claim_done` therefore does not transition anywhere: it schedules an adjudication and continues.
 * This is the jh completion gate's law with a screen as the witness instead of a command: an
 * unsatisfiable gate ends the run as `task_blocked: completion_unverified`, never as a pass.
 *
 * 🔴 **The Guard calls `ComputerActions.build`, and closing that hole is this slice's named
 * obligation.** S1 deliberately kept value-level action validation (keysym syntax, scroll bounds,
 * whole-pixel integrality, an empty `type` string) out of the proposal schema so there is ONE opinion
 * about `xdotool` — and nothing in S1 could force S4 to consult it. {@link buildAction} does, on every
 * acting step, and a refusal from `build` is a Guard refusal like any other. There is a test whose
 * only job is that a proposal `build` rejects never reaches an `act` command.
 *
 * ⚠️ **`sniffSpace` is not imported and must never be.** `coordinates.ts` says why in-file: a model
 * declaring `pixels` while emitting normalized is NEVER caught, because the result is an ordinary
 * top-left pixel. The space is declared in the task spec. (G8's source assertion is S6's.)
 *
 * ⚠️ **There is no coordinate-correction feedback path, by construction.** The 08-06 substrate note
 * predicts the failure precisely: under autolock *"an agent would conclude the grounder is wrong and
 * start 'fixing' coordinates"*. `pointerOffset` is CONFIGURATION, calibrated once, applied after
 * `toPixels` — never inferred from a verdict at run time.
 */

// ---------------------------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------------------------

/**
 * One ordered, closed, visual question. The LAST checkpoint in a spec is the done condition.
 *
 * ⚠️ **Prefer a presence read over a numeric read.** The Master of Magic hand-play recorded two
 * proofs that turn 1 ended — the *"Choose a new spell to research"* dialog appearing, and mana moving
 * 0 MP → 3 MP. A floor VLM reads *presence of an unusual dialog* far more reliably than *this number
 * is 3*, so the dialog is the checkpoint and the mana is the corroboration.
 */
export interface Checkpoint {
  readonly id: string
  readonly question: string
  /**
   * Optional executable-state verifier. A positive result may only CONFIRM a visual award; it can
   * never create one. The opaque id is resolved by the driver/system, never executed in-process.
   */
  readonly verifier?: { readonly id: string }
}

export interface Budget {
  readonly maxSteps: number
  readonly maxPromptTokens: number
}

export interface TaskSpec {
  readonly goal: string
  /** Ordered. The last one is the terminal checkpoint; an empty list can never reach `Done`. */
  readonly checkpoints: ReadonlyArray<Checkpoint>
  /** G7 — two HARD counters. Whichever trips first ends the run `Blocked(budget)`. */
  readonly budget: Budget
  /** DECLARED per model, never sniffed. `holo3.1` speaks `normalized-1000`. */
  readonly space: ComputerCoordinates.Space
  readonly viewport: ComputerCoordinates.Viewport
  /**
   * The pointer's rendering offset in PIXELS, e.g. the ~18×8 px wand-sprite hotspot measured under
   * DOSBox. Applied after `toPixels` so the sprite lands on the grounded point.
   *
   * ⚠️ **Not applied to the watch region.** The offset corrects where the pointer DRAWS relative to
   * where X puts it; the effect the harness measures still appears at the grounded coordinate, which
   * is where the model aimed and where it drew its box.
   */
  readonly pointerOffset?: ComputerCoordinates.Point
  /** Passed straight to `ComputerActions.build` — the display and the capture path. */
  readonly actionOptions: ComputerActions.Options
  /** K consecutive steps with no checkpoint advanced and no attributed change → `Blocked(no-progress)`. */
  readonly noProgressLimit?: number
}

export const DEFAULT_NO_PROGRESS_LIMIT = 4

/**
 * 🔴 **How many times a checkpoint award must be adjudicated before it counts. MEASURED, 2026-08-07.**
 *
 * G14 calibrates the TERMINAL checkpoint against the start frame, where the answer is known to be
 * `no`. The intermediate checkpoints had no such gate, and the 2.2 acceptance run awarded checkpoint
 * 3 at step 1 in all three runs on a frame where `CD MOM` had been *typed but not executed* — in one
 * run it never became true at all, so that run's honest score was 2/9 rather than the 3/9 printed.
 *
 * ⚠️ **The obvious generalization — ask every checkpoint against the start frame — was built and
 * MEASURED and it would NOT have caught this.** All seven questions of that battery answer 0/8 `yes`
 * on the start frame; the battery is calibrated in G14's sense. The false award happened on a NEAR
 * MISS (`C:\>CD MOM` typed, not executed), where the same question answered `yes` **11 times in 33**
 * across two probes while answering `no` correctly the rest of the time and `yes` 25/25 on the frame
 * where it is genuinely true. So the question discriminates; the *award* did not, because the loop
 * turned ONE sample of a stochastic channel into a PERMANENT advance.
 *
 * ⭐ **The premise that makes a re-ask worth anything is that it is an INDEPENDENT sample, and that
 * was measured rather than assumed**: every call is `temperature: 0`, and on this deployment two
 * identical back-to-back asks of the same question about the same frame **disagreed in 11 of 25
 * pairs**. Measured effect of requiring two: false awards **40% → 12%**, true awards **25/25 →
 * 25/25** — the positive control, without which suppressing false awards is indistinguishable from
 * making the checkpoint unreachable.
 *
 * Cost: one extra adjudication per CANDIDATE award, never per step.
 *
 * ⚠️ The depth is FIXED at one re-ask, in prose, not a constant (2026-09-03). This used to be
 * a `CHECKPOINT_CONFIRMATIONS = 1` documented as a dial whose raising "lowers the false rate further" —
 * but the gate below asks exactly once more and never read the number, so raising it changed nothing
 * except a test's arithmetic. A knob whose doc promises a dial and whose code ignores it is a lie told
 * to the next tuner; the measured effect above was of one re-ask, and one re-ask is what ships.
 */

/**
 * 🔴 **How far PAST the next unsatisfied checkpoint the battery may look on one frame. MEASURED,
 * 2026-08-08 — this is the fix for a battery that is a STOPWATCH rather than a progress marker.**
 *
 * The 2.2 acceptance run of 2026-08-08 played the *entire* hand-played oracle — DOS prompt to the
 * *"Choose a new spell to research"* dialog — and scored 4/9, because the ordered ratchet asked
 * exactly one question per frame and could therefore advance at most one checkpoint per step. A run
 * that clears one screen per step outruns it immediately, and in an ordered battery that is not
 * merely lossy: the frame that satisfies checkpoint k+1 is already gone by the time k is awarded,
 * so k+1…n become unreachable **forever**. It froze at 2/7 for twenty steps while the game was
 * being played correctly in front of it.
 *
 * ⭐ **The award is therefore decoupled from the exact frame, in the one direction that is sound.**
 * These checkpoints are stages of a MONOTONE progression through a state machine that is the game's,
 * not ours: Master of Magic cannot draw the overland map without having passed wizard creation, and
 * cannot show wizard creation without having left the main menu. So *a later checkpoint being true
 * is evidence that the earlier one was passed*, and awarding both is an inference from the
 * substrate's own structure rather than a guess. The converse — inferring a later checkpoint from an
 * earlier one — is nonsense and is not expressible here.
 *
 * ⚠️ **Ordering is KEPT and this is deliberate.** Asking every remaining checkpoint on every frame
 * would cost 7× the adjudication calls, and it would also destroy the two properties the ordering
 * buys: `checkpointIndex` is a watermark the driver scores directly, and the start-frame calibration
 * is only meaningful because every checkpoint is known-`no` before the run starts. What is wrong is
 * not that the battery is ordered — it is that an award required the exact frame.
 *
 * ⚠️ **The cost is one extra adjudication on a step that does NOT advance, and it is NOT gated on
 * the step having been `attributed`.** That gate was considered and refused for §7g's reason: an
 * overshoot is exactly as reachable on a step whose watch region measured `no-visible-effect` (G13
 * branch (b) — the effect rendered outside the region), so a guard gated on the run's own history
 * would be silent in a case it is written for.
 *
 * **Residual, named rather than hidden:** at depth 1 a run that clears TWO stages in one step still
 * jams. The depth is FIXED at one level, in prose (2026-09-03): this used to be a
 * `CHECKPOINT_LOOKAHEAD = 1` documented as a knob whose raising "costs one call per level", but the
 * probe below hard-codes `checkpointIndex + 1` and read the constant only as a boolean — setting it to
 * 2 looked one level ahead, exactly as before. Widening the probe is a state-machine change, not a
 * number; when someone makes it, the depth becomes a parameter of THAT loop.
 */

/** How many times one step may be re-prompted before the step is spent. G3: exactly one. */
export const REPAIRS_PER_STEP = 1

/**
 * 🔴 **How many ESCALATED re-prompts a repeat-refusal episode gets before the run stops. MEASURED,
 * 2026-08-07 — and the escalation is CHEAPER than what it replaces, not an extra call.**
 *
 * A structural repair says *"your reply was malformed"*; a repeat refusal says *"your reply was
 * well-formed and you are stuck"*. Until now both spent the same single {@link REPAIRS_PER_STEP} and
 * both ended the step the same way, and that conflation is what the 2.2 acceptance re-run ended on.
 * At Master of Magic's Game Options dialog the planner clicked
 * `(900,920)` → `attributed`, the identical click → `no-visible-effect`, and then **five consecutive
 * steps of `refused: repeat` while re-emitting the identical proposal**, until `no-progress` fired.
 *
 * ⚠️ **More attempts at the SAME question are measurably worthless here.** Those five steps each
 * carried a fresh repair, so the run drew **ten independent samples** — `temperature: 0` is not
 * deterministic on this deployment (11 of 25 back-to-back pairs disagree) — and every one of the ten
 * re-emitted `click(900,920)`. The observation prose differed on every line; the action never did. A
 * retry that re-sends the same prompt is not a repair, it is the same inference run again.
 *
 * So the second attempt's **content** differs: {@link repeatEscalationNote} names the banned action
 * and the measurement behind it, narrows the free-proposal question to a CLOSED choice, and offers
 * `abstain` explicitly at the one moment it is the right answer. Then the run stops with a reason
 * that names the SIGNATURE, the way `repeated-no-visible-effect` outranks `no-progress` in
 * {@link settle}.
 *
 * **The bound, and why it costs nothing:** one escalated note per episode, and an episode is at most
 * two steps. Replayed against the §7d run the episode ends at step 18 instead of step 21 — **4
 * planner calls instead of 10.** The escalated note *replaces* a note that is measurably inert; it
 * never adds a call, so its expected value is non-negative by construction. I do not expect it to
 * convert often; I am re-spending a call that is provably wasted today and buying a named
 * termination three steps earlier.
 *
 * ⚠️ **This changes nothing about G6 and nothing about §3.** The interlock still refuses the repeat
 * before execution, and the harness still never computes a corrected coordinate — the escalated note
 * suggests no target, and the model chooses from the image as it always did.
 */
export const REPEAT_ESCALATIONS = 1

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

export type BlockedReason =
  | "budget"
  /**
   * **G13.** Two consecutive actions on DIFFERENT targets left their watch regions byte-identical.
   *
   * 🔴 **This used to be called `pointer-not-reaching-target` and that name was a DIAGNOSIS, which is
   * the one thing this stop must not assert.** The signature has (at least) two causes and the
   * measurement cannot tell them apart: the pointer is not reaching the target (capture/grab —
   * DOSBox's `autolock`), or the pointer reaches it fine and the CONTROLS are not responding
   * visibly. The 2026-08-07 acceptance run is the counter-example that forced the rename —
   * `autolock=false` in that substrate and two of its steps were `attributed`, so the pointer
   * demonstrably reached targets, while the old detail sent the reader to check the emulator.
   * The name now states what was measured; {@link settle} carries the differential.
   */
  | "repeated-no-visible-effect"
  /** The planner will not stop proposing an action G6 has refused — see {@link REPEAT_ESCALATIONS}. */
  | "stuck-on-refused-action"
  | "no-progress"
  | "cannot-see"
  | "capture-failed"
  | "checkpoint-verifier-unavailable"
  | "done-unverifiable"

export type VoidReason =
  /** G14 — the terminal checkpoint answered yes on the START frame. */
  | "adjudicator-uncalibrated"
  /** The calibration reply could not be read at all, so the channel was never calibrated. */
  | "adjudicator-unreadable"
  /** A harness bug: an event arrived in a phase that cannot consume it. Never score such a run. */
  | "protocol"

export type Outcome =
  | { readonly kind: "done"; readonly detail: string; readonly checkpointsSatisfied: number }
  | { readonly kind: "blocked"; readonly reason: BlockedReason; readonly detail: string }
  | { readonly kind: "void"; readonly reason: VoidReason; readonly detail: string }

// ---------------------------------------------------------------------------------------------
// Commands and events
// ---------------------------------------------------------------------------------------------

export type CapturePurpose = "calibrate" | "observe" | "preaction"

/**
 * What the driver must do next.
 *
 * ⚠️ **`act` is a whole four-capture protocol, not one exec.** The driver takes the watch-scope idle
 * pair *after this command is issued and immediately before running the argv*, then the after
 * capture, and hands back the digests as an `ComputerEvidence.Input`. That grouping is deliberate:
 * `ComputerVerify.sampled()` requires (idle, idle, act, after) with **nothing** between the idle pair,
 * and a reducer that emitted the captures separately would let a driver interleave something there
 * without any test noticing.
 */
export type Command =
  | {
      readonly kind: "capture"
      readonly scope: "frame" | "watch"
      readonly purpose: CapturePurpose
      readonly region?: ComputerActions.Region
    }
  | { readonly kind: "ask-planner"; readonly prompt: ComputerPrompt.Prompt }
  | { readonly kind: "ask-grounder"; readonly prompt: ComputerPrompt.Prompt }
  | { readonly kind: "ask-preaction-critic"; readonly prompt: ComputerPrompt.Prompt }
  | { readonly kind: "ask-adjudicator"; readonly prompt: ComputerPrompt.Prompt }
  | {
      readonly kind: "verify-checkpoint"
      readonly verifierID: string
      readonly checkpoint: Checkpoint
    }
  | {
      readonly kind: "act"
      readonly action: ComputerActions.Action
      readonly execution: {
        readonly kind: "argv"
        readonly argv: ReadonlyArray<ReadonlyArray<string>>
        readonly env: Readonly<Record<string, string>>
      }
      /** Watch scope in PIXELS. `undefined` → the driver measures at whole-frame scope. */
      readonly watch?: ComputerActions.Region
    }
  | { readonly kind: "finish"; readonly outcome: Outcome }

export type Event =
  | { readonly kind: "start" }
  | {
      readonly kind: "captured"
      readonly capture: ComputerEvidence.Capture
      /** The frame the planner (or the adjudicator) will see. Absent on a failed capture. */
      readonly image?: ComputerPrompt.Image
    }
  | { readonly kind: "planner-replied"; readonly text: string; readonly promptTokens?: number }
  | { readonly kind: "grounder-replied"; readonly text: string; readonly promptTokens?: number }
  | { readonly kind: "preaction-critiqued"; readonly text: string; readonly promptTokens?: number }
  | { readonly kind: "adjudicated"; readonly text: string; readonly promptTokens?: number }
  | {
      readonly kind: "checkpoint-verified"
      readonly result: "pass" | "fail" | "unavailable"
      readonly evidence: string
    }
  | { readonly kind: "acted"; readonly evidence: ComputerEvidence.Input; readonly image?: ComputerPrompt.Image }
  | { readonly kind: "act-failed"; readonly reason: string }

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export type Phase =
  | "start"
  | "calibrate-capture"
  | "calibrate-adjudicate"
  | "observe"
  | "propose"
  | "ground"
  | "preaction-capture"
  | "preaction-critique"
  | "act"
  | "adjudicate-step"
  | "lookahead-checkpoint"
  | "confirm-checkpoint"
  | "verify-checkpoint"
  | "adjudicate-claim"
  | "terminal"

/** The current step's commitments, carried from Propose to the ledger line at Settle. */
interface Pending {
  readonly observation: string
  readonly summary: string
  readonly expect: string
  /**
   * The BUILT argv, stringified. G6 compares this rather than the proposal, because "byte-identical
   * action" has to mean *the same thing executes* — two proposals that differ only in a field the
   * builder drops are the same click.
   */
  readonly signature: string
  /** Absent for the two non-acting shapes (`abstain`, `claim_done`), which execute nothing. */
  readonly kind?: ComputerActions.Action["kind"]
  readonly attribution?: ComputerEvidence.Attribution
}

export interface State {
  readonly spec: TaskSpec
  readonly phase: Phase
  /** Steps STARTED. A step is one Observe → … → Settle cycle. */
  readonly step: number
  readonly promptTokens: number
  readonly ledger: ComputerLedger.Ledger
  /** Index of the next unsatisfied checkpoint. `=== checkpoints.length` means the terminal one passed. */
  readonly checkpointIndex: number
  /**
   * The newest frame, and ONLY the newest frame (G11).
   *
   * ⚠️ **A CROP IS NOT A FRAME.** The only other image the loop handles is C3's pre-action watch
   * capture, which is a region a few percent of the screen. It is a witness for one closed question
   * and is passed straight to that question's prompt; assigning it here silently redefines "the
   * screen" for every later reader of this field — the planner's repair and the checkpoint
   * adjudicator's fallback both take their image from it.
   */
  readonly image?: ComputerPrompt.Image
  readonly pending?: Pending
  /** The planner's accepted pointer proposal while the blind grounder supplies only its point. */
  readonly groundingDraft?: ComputerProposal.ProposalDraft
  /** C2: replies already drawn for the current frame/label; cleared before every new step. */
  readonly groundingReplies: number
  readonly groundingPoints: ReadonlyArray<ComputerProposal.PointDraft>
  readonly groundingIssues: ReadonlyArray<string>
  /** Pointer action parked while C3 checks its grounded point against a newer frame. */
  readonly preparedAction?: Extract<Command, { readonly kind: "act" }>
  readonly preactionTarget?: {
    readonly label: string
    readonly point: ComputerProposal.PointDraft
    readonly crop: { readonly width: number; readonly height: number; readonly x: number; readonly y: number }
  }
  readonly repairs: number
  readonly consecutiveAbstains: number
  readonly consecutiveNoEffect: number
  /**
   * The signature of the last action that measured `no-visible-effect`. Two roles:
   * **G6** refuses a byte-identical repeat before it executes, and **G13** compares it against the
   * next no-effect signature to separate a stuck target from a captured pointer.
   *
   * ⚠️ **Cleared by any step that is not a `no-visible-effect`**, so the ban is on repeating what just
   * failed rather than a permanent blacklist. An action that does nothing on the main menu can be
   * exactly right two screens later, and a run-long ban would refuse it while every diagnostic read
   * healthy — the same shape of silent wrongness the whole module is written against.
   */
  readonly lastNoEffect?: string
  /**
   * How many CONSECUTIVE steps have ended with nothing but `refused: repeat`. Zero after any step
   * that ended any other way, so it measures one stuck episode rather than a run-long tally.
   *
   * ⚠️ It is a STEP counter, not a refusal counter: a step that ends this way has already spent its
   * repair, so one unit here is two refused planner calls.
   */
  readonly repeatEpisode: number
  /**
   * How many steps in the WHOLE run have measured `attributed`. Run-long and never reset — unlike
   * every other counter here, which measures one episode.
   *
   * ⚠️ **It is reported by G13 and must never gate it.** See {@link g13Detail}: `autolock` captures
   * on the first click, so the canonical captured-pointer run *starts* with an attributed step, and
   * a guard gated on this being zero would be silent in exactly the case it exists for.
   *
   * ⚠️ Derived state, deliberately, rather than read back off the ledger's `verdict` column — that
   * field is a ratcheted 28-char display string (`ledger.ts`), and the mechanical guards read the
   * reducer's own counters and never that string.
   */
  readonly attributedSteps: number
  readonly noProgress: number
  /** Estimate of the prompt just sent, used when the driver reports no `usage.prompt_tokens`. */
  readonly lastPromptEstimate: number
  /**
   * Everything the step already measured, parked while a candidate checkpoint award is confirmed.
   *
   * ⚠️ It exists so the confirmation cannot RE-DERIVE the step's verdict. The attribution ladder ran
   * once, inside `next()`, and a second derivation would be a second opinion about one evidence set —
   * the same reason the driver reads verdicts off the reducer instead of recomputing them.
   */
  readonly confirming?: Measured
  /**
   * How many checkpoints the award currently being confirmed covers: 1 for the ordinary next-one
   * award, 2 when the one-level lookahead (`lookahead-checkpoint` below) found the run had already overshot. Parked beside
   * `confirming` so the confirmation phase never has to re-derive which question it is confirming.
   */
  readonly awarding?: number
  /** Parked continuation while a declared executable verifier checks a visual award. */
  readonly verification?:
    | { readonly kind: "step"; readonly measured: Measured; readonly awarding: number }
    | { readonly kind: "claim" }
  readonly outcome?: Outcome
}

/** The step's own measurements, complete before the confirmation call is even sent. */
interface Measured {
  readonly verdict: string
  readonly consecutiveNoEffect: number
  readonly lastNoEffect?: string
  readonly attributed: boolean
}

export const initial = (spec: TaskSpec): State => ({
  spec,
  phase: "start",
  step: 0,
  promptTokens: 0,
  ledger: ComputerLedger.empty,
  checkpointIndex: 0,
  groundingReplies: 0,
  groundingPoints: [],
  groundingIssues: [],
  repairs: 0,
  consecutiveAbstains: 0,
  consecutiveNoEffect: 0,
  repeatEpisode: 0,
  attributedSteps: 0,
  noProgress: 0,
  lastPromptEstimate: 0,
})

export interface Transition {
  readonly state: State
  readonly command: Command
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const terminalCheckpoint = (spec: TaskSpec): Checkpoint | undefined => spec.checkpoints[spec.checkpoints.length - 1]

const finish = (state: State, outcome: Outcome): Transition => ({
  state: { ...state, phase: "terminal", outcome },
  command: { kind: "finish", outcome },
})

const blocked = (state: State, reason: BlockedReason, detail: string): Transition =>
  finish(state, { kind: "blocked", reason, detail })

const voided = (state: State, reason: VoidReason, detail: string): Transition =>
  finish(state, { kind: "void", reason, detail })

/**
 * `n/m`, `n/m?` when a checkpoint award was CLAIMED this step and the confirming re-ask did not
 * agree, and `n/m^` when the award came from the one-level lookahead (`lookahead-checkpoint` below) — i.e. the run had already
 * overshot and one earlier checkpoint was awarded by monotone inference rather than by being seen.
 * That distinction is reported, never hidden: `^` is the mark of an award nobody looked at directly.
 *
 * ⚠️ **The marker lives in this column rather than in `verdict` because `verdict` is a ratcheted
 * field.** `FIELD_LIMIT.verdict` is 28 and the longest verdict the ladder can produce is
 * `needs-adjudication/pred:yes` at 27, pinned by `ledger.test.ts` against every attribution kind —
 * so appending anything there would start silently CLIPPING a measurement, which `ledger.ts` says
 * in-file is a lie about what was observed rather than an abbreviation. One character here costs
 * nothing and the planner still sees that its claim was refused.
 */
const checkpointColumn = (state: State, unconfirmed: boolean, lookahead: boolean): string =>
  `${state.checkpointIndex}/${state.spec.checkpoints.length}${unconfirmed ? "?" : lookahead ? "^" : ""}`

const record = (
  state: State,
  fields: { readonly verdict: string; readonly unconfirmed?: boolean; readonly lookahead?: boolean },
): State => ({
  ...state,
  ledger: ComputerLedger.append(state.ledger, {
    n: state.step,
    observation: state.pending?.observation ?? ComputerLedger.ABSENT,
    action: state.pending?.summary ?? ComputerLedger.ABSENT,
    expect: state.pending?.expect ?? ComputerLedger.ABSENT,
    verdict: fields.verdict,
    checkpoint: checkpointColumn(state, fields.unconfirmed === true, fields.lookahead === true),
  }),
})

/** Emit a model call, spending the token counter first (G7 — the harness decrements, not the model). */
const ask = (
  state: State,
  prompt: ComputerPrompt.Prompt,
  kind: "ask-planner" | "ask-grounder" | "ask-preaction-critic" | "ask-adjudicator",
): Transition => {
  if (state.promptTokens >= state.spec.budget.maxPromptTokens) {
    return blocked(
      state,
      "budget",
      `prompt-token budget spent: ${state.promptTokens} of ${state.spec.budget.maxPromptTokens} after ${state.step} step(s)`,
    )
  }
  const estimate = ComputerPrompt.estimateTokens(prompt)
  const command: Command = { kind, prompt }
  return { state: { ...state, lastPromptEstimate: estimate }, command }
}

const spend = (state: State, reported: number | undefined): State => ({
  ...state,
  promptTokens: state.promptTokens + (reported ?? state.lastPromptEstimate),
})

// ---------------------------------------------------------------------------------------------
// Settle — the terminal checks, in the design's order
// ---------------------------------------------------------------------------------------------

/**
 * **G13's detail — a DIFFERENTIAL, and the reason it is not a diagnosis.**
 *
 * 🔴 **The old text named DOSBox's `autolock` as the cause, and the 2026-08-07 acceptance run is the
 * case where that is FALSE.** `autolock=false` in that substrate and two of its steps measured
 * `attributed`, so the pointer demonstrably reached targets — yet the fix that made the run get
 * further also made this stop reachable there. **A diagnosis that names the wrong cause is worse than
 * a generic one: it sends the next reader to the emulator config while the real answer is on the
 * screen.**
 *
 * ⚠️ **The other candidate fix — gate the stop on the run never having had an `attributed` step — was
 * REFUSED, and the program's own measurement is what refuses it.** DOSBox `autolock` captures the
 * mouse *on the first click* (measured 2026-08-06; the run is written up in `verify.ts`'s header),
 * so the canonical autolock run is
 * one attributed step followed by an unbroken run of dead ones. Gating on "never attributed" would
 * disable G13 in **exactly** the scenario it was written for. The attributed history is evidence to
 * REPORT, never a condition to suppress the stop on.
 *
 * So: the observation is stated as fact, the causes are listed as a differential in both directions,
 * and the run's own attributed count is handed over as the discriminator the reader should weigh.
 * The one instruction that survives unchanged is *do not adjust coordinates* — §3 refuses automatic
 * coordinate correction by construction, and a signal that is weak in the `changed` direction would
 * walk the pointer into nonsense while every step reported progress.
 */
export const g13Detail = (attributedSteps: number): string =>
  "two consecutive actions on DIFFERENT targets left their watch regions byte-identical: the " +
  "commands ran and the screen did not move where they aimed. That measurement has two causes and " +
  "does not distinguish them. (a) The pointer is not reaching the target — a pointer capture or " +
  "grab, of which DOSBox's `autolock` is the known instance (it switches to relative motion after " +
  "the first click, so the host pointer moves correctly while the application's cursor does not " +
  "follow). (b) The pointer reaches the target and the CONTROLS do not respond visibly — an " +
  "already-selected or inert control, a modal that ignores the click, or an effect that renders " +
  "outside the watch region. " +
  (attributedSteps === 0
    ? "No step in this run has ever measured `attributed`, so nothing here has shown the pointer " +
      "reaching anything: (a) is the first thing to check."
    : `${attributedSteps} earlier step(s) in this run measured \`attributed\`, so the pointer HAS ` +
      "reached a target here and a substrate-wide capture is unlikely — though not excluded, since " +
      "`autolock` captures on the first click. Weigh (b) first: look at what was clicked.") +
  " Do not adjust coordinates."

/**
 * Everything that can end a run at the end of a step, then the next Observe.
 *
 * ⚠️ **The order is the design's and it is not interchangeable.** `Done` outranks every stop
 * condition (a run that finished on its last affordable step finished), and the autolock signature
 * outranks `no-progress` because it names a CAUSE — *"the pointer is not reaching the target"* — where
 * `no-progress` only reports that nothing is happening. Reporting the vaguer of two true findings is
 * how a run costs someone a day in a container.
 */
const settle = (state: State): Transition => {
  if (state.checkpointIndex >= state.spec.checkpoints.length && state.spec.checkpoints.length > 0) {
    return finish(state, {
      kind: "done",
      detail: `the terminal checkpoint (${terminalCheckpoint(state.spec)?.id}) was adjudicated affirmatively on a harness-captured frame`,
      checkpointsSatisfied: state.checkpointIndex,
    })
  }
  if (state.promptTokens >= state.spec.budget.maxPromptTokens) {
    return blocked(
      state,
      "budget",
      `prompt-token budget spent: ${state.promptTokens} of ${state.spec.budget.maxPromptTokens} after ${state.step} step(s)`,
    )
  }
  if (state.consecutiveNoEffect >= 2) {
    // G13. Do not spend 25 steps discovering this. See {@link g13Detail} for why the text is a
    // DIFFERENTIAL and not the autolock diagnosis it used to be.
    return blocked(state, "repeated-no-visible-effect", g13Detail(state.attributedSteps))
  }
  if (state.consecutiveAbstains >= 2) {
    return blocked(state, "cannot-see", "the planner abstained twice in a row — it cannot see the target")
  }
  const limit = state.spec.noProgressLimit ?? DEFAULT_NO_PROGRESS_LIMIT
  if (state.noProgress >= limit) {
    return blocked(
      state,
      "no-progress",
      `${state.noProgress} consecutive steps advanced no checkpoint and produced no attributed change`,
    )
  }
  return beginStep(state)
}

/** Start the next step: spend the step counter, then Observe. */
const beginStep = (state: State): Transition => {
  const step = state.step + 1
  if (step > state.spec.budget.maxSteps) {
    return blocked(
      state,
      "budget",
      `step budget spent: ${state.spec.budget.maxSteps} step(s) at ${state.promptTokens} prompt tokens`,
    )
  }
  return {
    state: {
      ...state,
      phase: "observe",
      step,
      repairs: 0,
      pending: undefined,
      groundingDraft: undefined,
      groundingReplies: 0,
      groundingPoints: [],
      groundingIssues: [],
      preparedAction: undefined,
      preactionTarget: undefined,
    },
    command: { kind: "capture", scope: "frame", purpose: "observe" },
  }
}

// ---------------------------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------------------------

type Refusal = { readonly ok: false; readonly reason: string }
type BuiltAction = {
  readonly ok: true
  readonly action: ComputerActions.Action
  readonly execution: { readonly kind: "argv"; readonly built: ComputerActions.Valid }
  readonly watch?: ComputerActions.Region
  /**
   * The grounded point in `watch`'s OWN frame, plus that frame's size — the pre-action critic's
   * whole coordinate contract, ready to hand over.
   *
   * 🔴 **It is computed where both points are in scope, so the call site never has a pair to choose
   * between.** A built pointer action carries two pixel points that differ by `pointerOffset`: the
   * grounded one, which is what `watch` is centred on and what the critic is looking at, and the
   * offset one, which is where the pointer must be *moved* for its sprite to render on the grounded
   * one. Subtracting the offset point from the watch origin mixes the two frames and tells the
   * critic to judge a pixel the action will not touch — and the critic's prompt states that point as
   * fact, so a correct grounding gets rejected or a wrong one approved on the harness's own error.
   * With the arithmetic done here there is no second point at the call site to get it wrong with.
   */
  readonly watchCrop?: {
    readonly width: number
    readonly height: number
    readonly x: number
    readonly y: number
  }
}

const describeConversion = (error: ComputerCoordinates.ConversionError, what: string): string => {
  switch (error.kind) {
    case "not-finite":
      return `${what}: ${error.axis} is not a finite number`
    case "viewport-invalid":
      return `${what}: the viewport is invalid (${error.viewport.width}×${error.viewport.height})`
    case "out-of-range":
      return (
        `${what}: ${error.axis}=${error.value} is outside the declared 0–${error.max} range` +
        (error.alsoValidAs.length === 0 ? "" : ` (it would be in range as ${error.alsoValidAs.join(" or ")})`)
      )
  }
}

const toPixelPoint = (
  point: ComputerProposal.PointDraft,
  spec: TaskSpec,
  what: string,
): { readonly ok: true; readonly point: ComputerCoordinates.Point } | Refusal => {
  const converted = ComputerCoordinates.toPixels(point, spec.space, spec.viewport)
  // Errors are SURFACED, never clamped — a clamped point is a silent misclick (coordinates.ts).
  if (!converted.ok) return { ok: false, reason: describeConversion(converted.error, what) }
  return { ok: true, point: converted.point }
}

/**
 * The verifier's local watch, derived from the grounded point rather than guessed by the planner.
 * 64/1000 of each axis reproduces the scale used in the acceptance runs while remaining
 * resolution-independent. At an edge the box shifts inward, so it contains the point without asking
 * `scrot` for pixels outside the viewport.
 */
export const watchAround = (
  point: ComputerCoordinates.Point,
  viewport: ComputerCoordinates.Viewport,
): ComputerActions.Region => {
  const width = Math.max(1, Math.min(viewport.width, Math.round(viewport.width * 0.064)))
  const height = Math.max(1, Math.min(viewport.height, Math.round(viewport.height * 0.064)))
  return {
    x: Math.max(0, Math.min(viewport.width - width, Math.round(point.x - width / 2))),
    y: Math.max(0, Math.min(viewport.height - height, Math.round(point.y - height / 2))),
    width,
    height,
  }
}

const BUTTONS: ReadonlyArray<ComputerActions.Button> = ["left", "middle", "right"]

/**
 * Draft → a real {@link ComputerActions.Action} → `ComputerActions.build`.
 *
 * 🔴 **This is the deferred hole S1 named, closed.** Value-level validation lives in `build` so there
 * is one opinion about `xdotool`; the only way that opinion binds is if the Guard asks for it, and
 * this is where it asks. A `build` refusal — a bad keysym, a scroll of 40, a non-integral pixel, an
 * empty `type` — comes back as a Guard refusal and re-prompts the planner rather than executing.
 */
const buildAction = (
  draft: ComputerProposal.ProposalDraft,
  spec: TaskSpec,
  grounded?: ComputerProposal.PointDraft,
): BuiltAction | Refusal => {
  const source = draft.action
  if (source == null) return { ok: false, reason: "no action" }
  const kind = typeof source.kind === "string" ? source.kind.trim() : ""
  if (!ComputerProposal.isActionKind(kind)) return { ok: false, reason: `not an action kind: ${kind || "(absent)"}` }
  if (ComputerProposal.isPointerKind(kind) && grounded === undefined)
    return { ok: false, reason: `${kind} needs a point from the blind grounder` }

  let point: ComputerCoordinates.Point | undefined
  let watchPoint: ComputerCoordinates.Point | undefined
  if (grounded !== undefined) {
    const converted = toPixelPoint(grounded, spec, "grounded point")
    if (!converted.ok) return converted
    watchPoint = converted.point
    const offset = spec.pointerOffset
    point =
      offset === undefined ? converted.point : { x: converted.point.x + offset.x, y: converted.point.y + offset.y }
  }

  let action: ComputerActions.Action
  switch (kind) {
    case "move":
      if (point === undefined) return { ok: false, reason: "move needs a point" }
      action = { kind: "move", point }
      break
    case "click": {
      const raw = (source.button ?? "left").trim().toLowerCase()
      const button = BUTTONS.find((b) => b === raw)
      if (button === undefined) return { ok: false, reason: `not a button: ${source.button}` }
      action = point === undefined ? { kind: "click", button } : { kind: "click", button, point }
      break
    }
    case "double_click":
      action = point === undefined ? { kind: "double_click" } : { kind: "double_click", point }
      break
    case "type":
      if (source.text == null) return { ok: false, reason: "type needs text" }
      action = { kind: "type", text: source.text }
      break
    case "type_submit":
      if (source.text == null) return { ok: false, reason: "type_submit needs text" }
      action = { kind: "type_submit", text: source.text }
      break
    case "key":
      if (source.keys == null) return { ok: false, reason: "key needs keys" }
      action = { kind: "key", keys: source.keys }
      break
    case "scroll": {
      const direction = (source.direction ?? "").trim().toLowerCase()
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right")
        return { ok: false, reason: `not a scroll direction: ${source.direction}` }
      if (source.amount == null) return { ok: false, reason: "scroll needs an amount" }
      action = { kind: "scroll", direction, amount: source.amount }
      break
    }
  }

  // 🔴 The one opinion about `xdotool`. Everything above is shape; this is the value check.
  const built = ComputerActions.build(action, spec.actionOptions)
  if (!built.ok) return { ok: false, reason: built.reason }

  const execution = { kind: "argv", built } as const
  if (watchPoint === undefined) return { ok: true, action, execution }
  const watch = watchAround(watchPoint, spec.viewport)
  return {
    ok: true,
    action,
    execution,
    watch,
    // `watchPoint`, never `point`: the offset moves the pointer's sprite, not the region, and this
    // is the region's own frame. See {@link BuiltAction.watchCrop}.
    watchCrop: { width: watch.width, height: watch.height, x: watchPoint.x - watch.x, y: watchPoint.y - watch.y },
  }
}

// ---------------------------------------------------------------------------------------------
// The grounding label the planner must send
// ---------------------------------------------------------------------------------------------

/**
 * An article. A control is labelled `Bottom Align`; a *description* of one says `at the bottom`.
 *
 * ⚠️ Deliberately not the bare `a`: `Left Channel A` is a label, and one letter is too cheap a way
 * to make a legitimate one unsendable — which is the exact failure this whole predicate exists to
 * undo.
 */
const ARTICLE = /(^|[^a-z])(the|an)([^a-z]|$)/

/**
 * `undefined` when the planner's grounding label may go to the blind grounder, otherwise the reason
 * the harness refuses it.
 *
 * 🔴 **`grounderLabelIssue` is a WARNING channel and says so in its own doc** — *"a label containing
 * the word 'right' is not automatically a description — a control can be **labelled** 'Right'. The
 * caller decides."* This is the caller deciding, and the deciding rule that matters is that a legal
 * answer must always EXIST. Refusing every control whose visible text contains a positional word,
 * while the refusal note instructs the model to *"use the control's visible label and nothing else"*,
 * is an instruction nothing can satisfy: a button genuinely labelled `Left Channel`, `Top` or
 * `Bottom Align` has no compliant spelling, so the repair is spent, the step ends `noProgress + 1`,
 * and four of those reach `Blocked(no-progress)` on a task the model was never able to attempt.
 *
 * So the positional signal is refused only when the label also reads as a CLAUSE rather than a name,
 * which is the shape the measurement had (*"the DONE button located at the bottom right of the
 * screen, below the unit portraits and to the left of the PATROL button"*, 2/25 against 25/25 for
 * the bare label). Two marks, either sufficient:
 *
 * 1. **an article** — no control's visible text contains `the`;
 * 2. **more than three words carrying more than one positional word** — `Top Left Corner` is a
 *    plausible anchor-picker label; a five-word phrase relating a control to two others is not.
 *
 * Both leave the correction reachable: dropping the article and keeping the name is always a legal
 * label, which is precisely what the old refusal could not promise.
 *
 * ⚠️ **The positional vocabulary stays in `prompt.ts` and is only ever asked, never copied.** The
 * count comes from probing the module's own predicate word by word, so a word added there is counted
 * here with no second list to keep in step.
 *
 * An EMPTY label is a different refusal and stays terminal: there is no visible text to point at, so
 * no rewrite of the label can produce one.
 */
export const groundingLabelRefusal = (label: string): string | undefined => {
  const trimmed = label.trim()
  const issue = ComputerPrompt.grounderLabelIssue(trimmed)
  if (issue === undefined) return undefined
  if (trimmed === "") return issue
  const words = trimmed.split(/\s+/).filter((word) => word !== "")
  const positional = words.filter((word) => ComputerPrompt.grounderLabelIssue(word) !== undefined).length
  const readsAsClause = ARTICLE.test(trimmed.toLowerCase()) || (words.length > 3 && positional > 1)
  return readsAsClause ? issue : undefined
}

// ---------------------------------------------------------------------------------------------
// Re-prompting one step, and giving up on it
// ---------------------------------------------------------------------------------------------

/**
 * G6's FIRST refusal note. Unchanged, and deliberately: as attempt one it is the cheap ask, and the
 * §7d measurement is about what happens when it does not land — not about this wording.
 */
export const REPEAT_REFUSAL_NOTE =
  "The harness REFUSED to execute that action: it is byte-identical to the previous one, which " +
  "left the watched region unchanged. Repeating it cannot produce a different result. " +
  "Re-ground from the current screen, or try a different target.\n\nRe-emit the WHOLE proposal, corrected."

/**
 * G6's SECOND note, and the whole point is that it is a **different question**, not the same one
 * asked louder — see {@link REPEAT_ESCALATIONS} for why an identical re-ask is worthless here.
 *
 * Three things change: it states the harness's own MEASUREMENT (the command ran and the pixels did
 * not move) rather than repeating the refusal; it narrows a free proposal to a **closed choice**;
 * and it puts `abstain` in front of the planner at the one moment it is the correct answer, which
 * `CONTRACT_LINES` only ever mentions in passing at the bottom of a contract the model has by then
 * read many times.
 *
 * ⚠️ **No coordinate appears here that the model did not itself emit** (§3). `action` is
 * `ComputerLedger.summarizeAction` of the planner's own draft — the harness names what is banned and
 * never where to aim instead.
 */
export const repeatEscalationNote = (input: { readonly action: string; readonly steps: number }): string =>
  [
    `You have now proposed ${input.action} in ${input.steps} consecutive steps and the harness has ` +
      "refused it every time. Before the first refusal it EXECUTED that action and MEASURED the " +
      "region you asked it to watch: the pixels did not change. That is not an opinion about your " +
      "aim — the command ran, and the screen did not move.",
    "",
    "Two things would produce that measurement and this log cannot tell them apart: the control you " +
      "are aiming at is not the control you believe it is, or it is already in the state you want. " +
      "Either way that action is spent for this screen and the harness will not run it again.",
    "",
    "Answer with exactly ONE of these two, and nothing else:",
    `  1. an ACT proposal whose action differs from ${input.action} — a different target, or a ` +
      "different KIND of action (key and type are actions too; the pointer is not the only channel).",
    '  2. ABSTAIN — {"abstain": true, "reason": "…"} — if you cannot justify any other action from ' +
      "this screen. Abstaining is a legal, correct answer, and it is the right one when the only " +
      "move you can see has already been measured as doing nothing. It is not a failure and it is " +
      "not giving up on the goal.",
    "",
    "Re-emit the WHOLE proposal, corrected.",
  ].join("\n")

const stuckDetail = (action: string, steps: number): string =>
  `the planner proposed ${action} in ${steps} consecutive steps after the harness had measured that ` +
  "exact action as leaving its own watched region unchanged, and it re-emitted it once more after the " +
  "escalated refusal that names the measurement and offers `abstain` as the alternative. Each of " +
  "those steps drew two independent samples, so re-asking is not a repair — the planner has one " +
  "hypothesis and no way to generate a second. ⚠️ This is NOT a grounding failure for the harness to " +
  "correct: no coordinate is inferred from a verdict here, by construction. The next lever is the " +
  "task's own instructions or a different actuation channel, and both are outside this loop."

/**
 * One repair or Guard refusal, then the step is spent — G3: an unbounded repair loop is a budget leak.
 *
 * `repeat` is present only for a G6 refusal, which is the one refusal that is not about the shape of
 * the reply. It carries the episode counter and, once {@link REPEAT_ESCALATIONS} is spent, ends the
 * run naming the cause instead of leaving `no-progress` to report the symptom three steps later.
 */
const reprompt = (
  state: State,
  note: string,
  verdict: string,
  pending?: Pending,
  repeat?: { readonly action: string },
): Transition => {
  if (state.repairs >= REPAIRS_PER_STEP) {
    // ⚠️ Any step that ends for a reason OTHER than a repeat refusal clears the episode. The counter
    // measures "the planner is stuck on this one action", not "the planner has had a bad run".
    const episode = repeat === undefined ? 0 : state.repeatEpisode + 1
    const settled = record({ ...state, pending }, { verdict })
    const spent: State = { ...settled, noProgress: settled.noProgress + 1, pending: undefined, repeatEpisode: episode }
    if (repeat !== undefined && state.repeatEpisode >= REPEAT_ESCALATIONS) {
      return blocked(spent, "stuck-on-refused-action", stuckDetail(repeat.action, episode))
    }
    return settle(spent)
  }
  return ask(
    {
      ...state,
      phase: "propose",
      repairs: state.repairs + 1,
      groundingDraft: undefined,
      groundingReplies: 0,
      groundingPoints: [],
      groundingIssues: [],
    },
    ComputerPrompt.planner({
      goal: state.spec.goal,
      ledger: state.ledger,
      image: state.image,
      note,
    }),
    "ask-planner",
  )
}

/** Validate/build one accepted proposal, then apply the repeat interlock and schedule its action. */
const scheduleAction = (
  state: State,
  draft: ComputerProposal.ProposalDraft,
  described: Pending,
  grounded?: ComputerProposal.PointDraft,
): Transition => {
  const build = buildAction(draft, state.spec, grounded)
  if (!build.ok) {
    return reprompt(
      state,
      `The harness REFUSED to execute your action: ${build.reason}\n\nRe-emit the WHOLE proposal, corrected.`,
      `refused: ${build.reason}`,
      described,
    )
  }
  const signature = JSON.stringify(build.execution.built.argv)
  if (state.lastNoEffect !== undefined && state.lastNoEffect === signature) {
    const note =
      state.repeatEpisode === 0
        ? REPEAT_REFUSAL_NOTE
        : repeatEscalationNote({ action: described.summary, steps: state.repeatEpisode + 1 })
    return reprompt(state, note, "refused: repeat", described, { action: described.summary })
  }
  const command: Extract<Command, { kind: "act" }> = {
    kind: "act",
    action: build.action,
    execution: { kind: "argv", argv: build.execution.built.argv, env: build.execution.built.env },
    ...(build.watch === undefined ? {} : { watch: build.watch }),
  }
  const acting: State = {
    ...state,
    phase: "act",
    consecutiveAbstains: 0,
    repeatEpisode: 0,
    groundingDraft: undefined,
    pending: { ...described, signature, kind: build.action.kind },
  }
  // C3 applies to screenshot-grounded pointer actions; key/type/scroll have no proposed coordinate to check.
  const actionPoint = "point" in build.action ? build.action.point : undefined
  if (
    grounded !== undefined &&
    build.watch !== undefined &&
    build.watchCrop !== undefined &&
    actionPoint !== undefined
  ) {
    return {
      state: {
        ...acting,
        phase: "preaction-capture",
        preparedAction: command,
        preactionTarget: {
          label: draft.action?.target?.trim() ?? "",
          point: grounded,
          // Handed over whole by `buildAction`. There is deliberately no arithmetic here: this call
          // site can see `build.action.point` — the OFFSET point — and picking it would displace the
          // critic's marker from where the click lands without changing anything the tests watch.
          crop: build.watchCrop,
        },
      },
      command: {
        kind: "capture",
        scope: "watch",
        purpose: "preaction",
        ...(build.watch === undefined ? {} : { region: build.watch }),
      },
    }
  }
  return { state: acting, command }
}

// ---------------------------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------------------------

const unexpected = (state: State, event: Event): Transition =>
  voided(state, "protocol", `a ${event.kind} event arrived in phase ${state.phase}`)

/**
 * Fold a step's already-taken measurements into the state and settle.
 *
 * Split out of `adjudicate-step` when the confirmation gate landed, because the fold now has two
 * call sites — the ordinary step and the confirmed award — and two copies of it would be two
 * opinions about how a step ends.
 */
const settleMeasured = (state: State, measured: Measured, advance: number, unconfirmed = false): Transition => {
  const advanced = advance > 0
  const advancedState: State = {
    ...state,
    checkpointIndex: state.checkpointIndex + advance,
    consecutiveNoEffect: measured.consecutiveNoEffect,
    lastNoEffect: measured.lastNoEffect,
    // Run-long, never reset — G13's differential reports it. A REFUSED award still counts here if
    // the screen moved: this asks whether the pointer ever reached anything, not whether the run
    // made progress, and those are different questions (`noProgress` below answers the other one).
    attributedSteps: state.attributedSteps + (measured.attributed ? 1 : 0),
    // ⚠️ A REFUSED award is not progress. It reads as an advance to a casual reader and is exactly
    // the inflation this gate exists to stop, so it falls through to the `attributed` test like any
    // other step and increments `noProgress` when the screen did not move either.
    noProgress: advanced || measured.attributed ? 0 : state.noProgress + 1,
    confirming: undefined,
    awarding: undefined,
    verification: undefined,
  }
  const logged = record(advancedState, { verdict: measured.verdict, unconfirmed, lookahead: advance > 1 })
  return settle({ ...logged, pending: undefined })
}

const confirmClaim = (state: State): Transition => {
  const done: State = { ...state, checkpointIndex: state.spec.checkpoints.length, verification: undefined }
  return settle(record(done, { verdict: "claim confirmed" }))
}

/**
 * A programmatic verifier is a VETO over an already-visual award, never a source of an award.
 * Absence preserves today's visual protocol byte-for-byte. Presence emits a reducer-owned command
 * so the callback, its evidence, and every failure remain visible to the run report.
 */
const verifyOrContinue = (
  state: State,
  checkpoint: Checkpoint,
  verification: NonNullable<State["verification"]>,
  otherwise: Transition,
): Transition => {
  if (checkpoint.verifier === undefined) return otherwise
  return {
    state: { ...state, phase: "verify-checkpoint", verification },
    command: { kind: "verify-checkpoint", verifierID: checkpoint.verifier.id, checkpoint },
  }
}

export function next(state: State, event: Event): Transition {
  if (state.phase === "terminal") {
    return {
      state,
      command: {
        kind: "finish",
        outcome: state.outcome ?? { kind: "void", reason: "protocol", detail: "already terminal" },
      },
    }
  }

  switch (state.phase) {
    // ── Start ─────────────────────────────────────────────────────────────────────────────────
    case "start": {
      if (event.kind !== "start") return unexpected(state, event)
      // G1's tail, checked before a single token is spent: a task with no terminal checkpoint has no
      // done condition, so it can never reach `Done` and saying so up front is cheaper than
      // discovering it after 25 steps.
      if (state.spec.checkpoints.length === 0) {
        return blocked(
          state,
          "done-unverifiable",
          "the task supplied no checkpoints, so there is no terminal condition a harness-invoked " +
            "adjudication could confirm. `Done` is unreachable by construction — this is not a failure " +
            "of the run, it is a failure of the task spec.",
        )
      }
      return {
        state: { ...state, phase: "calibrate-capture" },
        command: { kind: "capture", scope: "frame", purpose: "calibrate" },
      }
    }

    // ── Calibrate (G14) ───────────────────────────────────────────────────────────────────────
    case "calibrate-capture": {
      if (event.kind !== "captured") return unexpected(state, event)
      if (!event.capture.ok)
        return blocked(state, "capture-failed", `the start frame was not captured: ${event.capture.reason}`)
      const withImage: State = { ...state, phase: "calibrate-adjudicate", image: event.image }
      return ask(
        withImage,
        ComputerPrompt.adjudicator({ checkpoint: terminalCheckpoint(state.spec), image: event.image }),
        "ask-adjudicator",
      )
    }

    case "calibrate-adjudicate": {
      if (event.kind !== "adjudicated") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)
      const parsed = ComputerPrompt.parseAdjudication(event.text)
      if (!parsed.ok) {
        return voided(
          spent,
          "adjudicator-unreadable",
          `the calibration reply could not be read (${parsed.issue}), so the channel every verdict depends on was never calibrated`,
        )
      }
      if (parsed.reply.checkpoint === "yes") {
        // The only thing in the design that can falsify the design: the terminal checkpoint is known
        // to be false on the start frame, so a yes means the channel answers yes to everything and
        // every verdict downstream is noise. Report `Void`, never a score.
        return voided(
          spent,
          "adjudicator-uncalibrated",
          `the adjudicator answered YES to the terminal checkpoint (${terminalCheckpoint(state.spec)?.id}) on the START frame, where the answer is known to be no`,
        )
      }
      return beginStep(spent)
    }

    // ── Observe ───────────────────────────────────────────────────────────────────────────────
    case "observe": {
      if (event.kind !== "captured") return unexpected(state, event)
      if (!event.capture.ok)
        return blocked(state, "capture-failed", `the observe frame was not captured: ${event.capture.reason}`)
      const observed: State = { ...state, phase: "propose", image: event.image }
      return ask(
        observed,
        ComputerPrompt.planner({
          goal: state.spec.goal,
          ledger: state.ledger,
          image: event.image,
        }),
        "ask-planner",
      )
    }

    // ── Propose + Guard ───────────────────────────────────────────────────────────────────────
    case "propose": {
      if (event.kind !== "planner-replied") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)

      const parsed = ComputerProposal.parseProposal(event.text)
      if (!parsed.ok) {
        return reprompt(spent, ComputerProposal.repairPrompt({ parseFailure: parsed.issue }), "unreadable reply")
      }
      const draft = parsed.draft
      const issues = ComputerProposal.structuralIssues(draft)
      const errors = ComputerProposal.errorsOf(issues)
      if (errors.length > 0) {
        return reprompt(spent, ComputerProposal.repairPrompt({ issues }), `rejected: ${errors[0]?.code}`)
      }

      // ── abstain (G12/A14.3): a legal, correct answer — never an error.
      if (draft.abstain === true) {
        const abstained: State = {
          ...spent,
          pending: {
            observation: draft.observation ?? ComputerLedger.ABSENT,
            summary: "abstain",
            expect: draft.reason ?? ComputerLedger.ABSENT,
            signature: "",
            kind: "cursor",
          },
          consecutiveAbstains: spent.consecutiveAbstains + 1,
          noProgress: spent.noProgress + 1,
          // An abstain is the escalation's own preferred answer, so it ends the stuck episode: the
          // planner stopped repeating, and `consecutiveAbstains` is now the counter that speaks.
          repeatEpisode: 0,
        }
        return settle(record(abstained, { verdict: "abstained" }))
      }

      // ── claim_done (G1): a PROPOSAL. It schedules an adjudication; it transitions nothing.
      if (draft.claim_done === true) {
        const claiming: State = {
          ...spent,
          phase: "adjudicate-claim",
          consecutiveAbstains: 0,
          repeatEpisode: 0,
          pending: {
            observation: draft.observation ?? ComputerLedger.ABSENT,
            summary: "claim_done",
            expect: draft.evidence ?? ComputerLedger.ABSENT,
            signature: "",
            kind: "cursor",
          },
        }
        // The model's evidence sentence is NOT forwarded: the reader is asked the harness's own
        // terminal question about the harness's own frame, which is the entire content of G1.
        return ask(
          claiming,
          ComputerPrompt.adjudicator({ checkpoint: terminalCheckpoint(state.spec), image: spent.image }),
          "ask-adjudicator",
        )
      }

      // ── Guard ───────────────────────────────────────────────────────────────────────────────
      const described: Pending = {
        observation: draft.observation ?? ComputerLedger.ABSENT,
        summary: ComputerLedger.summarizeAction(draft.action),
        expect: draft.expect ?? ComputerLedger.ABSENT,
        signature: "",
      }
      const actionKind = draft.action?.kind?.trim() ?? ""
      if (ComputerProposal.isPointerKind(actionKind)) {
        const target = draft.action?.target?.trim() ?? ""
        const issue = groundingLabelRefusal(target)
        if (issue !== undefined) {
          return reprompt(
            spent,
            `The harness REFUSED the grounding label ${JSON.stringify(target)}: ${issue}. ` +
              "Use the control's visible label and nothing else.\n\nRe-emit the WHOLE proposal, corrected.",
            "refused: bad grounding label",
            described,
          )
        }
        const grounding: State = {
          ...spent,
          phase: "ground",
          pending: described,
          groundingDraft: draft,
          groundingReplies: 0,
          groundingPoints: [],
          groundingIssues: [],
        }
        return ask(grounding, ComputerPrompt.grounder({ label: target, image: spent.image }), "ask-grounder")
      }
      return scheduleAction(spent, draft, described)
    }

    // ── Blind grounding: the point comes from a goal/ledger-free second call. ──────────────────
    case "ground": {
      if (event.kind !== "grounder-replied") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)
      const grounded = ComputerPrompt.parseGrounding(event.text)
      if (state.groundingDraft === undefined || state.pending === undefined)
        return voided(spent, "protocol", "the grounder replied without a pending planner proposal")
      const converted = grounded.ok
        ? ComputerCoordinates.toPixels(grounded.point, state.spec.space, state.spec.viewport)
        : undefined
      const sampled: State = {
        ...spent,
        groundingReplies: state.groundingReplies + 1,
        groundingPoints:
          grounded.ok && converted?.ok ? [...state.groundingPoints, grounded.point] : state.groundingPoints,
        groundingIssues: !grounded.ok
          ? [...state.groundingIssues, grounded.issue]
          : converted !== undefined && !converted.ok
            ? [...state.groundingIssues, describeConversion(converted.error, "grounded point")]
            : state.groundingIssues,
      }
      if (sampled.groundingReplies < ComputerGroundingConsensus.SAMPLE_COUNT) {
        const label = state.groundingDraft.action?.target?.trim() ?? ""
        return ask(sampled, ComputerPrompt.grounder({ label, image: state.image }), "ask-grounder")
      }
      const consensus = ComputerGroundingConsensus.vote({
        points: sampled.groundingPoints,
        requested: sampled.groundingReplies,
        space: state.spec.space,
        viewport: state.spec.viewport,
      })
      if (!consensus.ok) {
        const issues = sampled.groundingIssues.length
          ? ` Grounding issues: ${[...new Set(sampled.groundingIssues)].join("; ")}.`
          : ""
        return reprompt(
          sampled,
          `The blind grounder did not reach spatial consensus (${consensus.reason}).${issues} ` +
            "Choose a different visible label or abstain.\n\nRe-emit the WHOLE proposal, corrected.",
          "grounding consensus failed",
          state.pending,
        )
      }
      return scheduleAction(sampled, state.groundingDraft, state.pending, consensus.point)
    }

    // ── C3: observe the grounded point again, then ask a different closed question. ───────────
    case "preaction-capture": {
      if (event.kind !== "captured") return unexpected(state, event)
      if (!event.capture.ok)
        return blocked(state, "capture-failed", `the pre-action frame was not captured: ${event.capture.reason}`)
      if (event.image === undefined)
        return blocked(state, "capture-failed", "the pre-action capture produced no image for the grounded critic")
      if (state.preactionTarget === undefined || state.preparedAction === undefined || state.pending === undefined)
        return voided(state, "protocol", "the pre-action capture arrived without a parked pointer action")
      // 🔴 The pre-action capture is a WATCH CROP — `watchAround` sizes it at ~6% of each axis — so
      // it is NOT a frame, and it must never reach `State.image`, whose contract one field over is
      // "the newest frame, and ONLY the newest frame (G11)". It goes to the critic, which is asked a
      // closed question about exactly that patch, and nowhere else. Writing it to `State.image`
      // showed the PLANNER the patch under the instruction "Re-ground from this screen" — a
      // re-grounding request against 6% of the screen, which it can only answer by re-emitting or
      // abstaining — and left the checkpoint ADJUDICATOR reading the same patch on the acting path,
      // where `image: event.image ?? state.image` falls back whenever the after-frame capture fails.
      const checking: State = { ...state, phase: "preaction-critique" }
      return ask(
        checking,
        ComputerPrompt.preActionCritic({
          action: state.pending.summary,
          label: state.preactionTarget.label,
          point: state.preactionTarget.point,
          crop: state.preactionTarget.crop,
          ledger: state.ledger,
          image: event.image,
        }),
        "ask-preaction-critic",
      )
    }

    case "preaction-critique": {
      if (event.kind !== "preaction-critiqued") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)
      if (state.preparedAction === undefined || state.pending === undefined)
        return voided(spent, "protocol", "the pre-action critic replied without a parked pointer action")
      const critique = ComputerPrompt.parsePreActionCritique(event.text)
      if (!critique.ok) {
        return reprompt(
          spent,
          `The harness REFUSED to act because the grounded safety check was unreadable (${critique.issue}). ` +
            "Re-ground from the current screen, choose a different target, or abstain.\n\nRe-emit the WHOLE proposal, corrected.",
          "refused: unreadable pre-action critique",
          state.pending,
        )
      }
      if (!critique.approve) {
        return reprompt(
          spent,
          `The harness REFUSED to act after checking the point against the current screen: ${critique.reason}. ` +
            "Re-ground from this screen, choose a different target, or abstain.\n\nRe-emit the WHOLE proposal, corrected.",
          "refused: pre-action critique",
          state.pending,
        )
      }
      return {
        state: {
          ...spent,
          phase: "act",
          preparedAction: undefined,
          preactionTarget: undefined,
        },
        command: state.preparedAction,
      }
    }

    // ── Act → Verify ──────────────────────────────────────────────────────────────────────────
    case "act": {
      if (event.kind === "act-failed") {
        const failed = record(state, { verdict: `act-failed: ${event.reason}` })
        return settle({ ...failed, noProgress: failed.noProgress + 1, pending: undefined, repeatEpisode: 0 })
      }
      if (event.kind !== "acted") return unexpected(state, event)

      const attribution = ComputerEvidence.attribute(event.evidence)

      // 🔴 G2 — a failed capture is NEVER a `no-visible-effect`. `scrot -o` overwrites one path, so a
      // failed capture leaves the PREVIOUS frame and its digest reads as an unchanged screen, forging
      // the strongest evidence the system has. `ComputerEvidence.attribute` makes that inexpressible;
      // this is where the loop refuses to keep going on an unobserved screen.
      if (attribution.kind === "capture-failed") {
        return blocked(
          state,
          "capture-failed",
          `${attribution.failed.map((f) => `${f.capture} (${f.reason})`).join(", ")} — ${attribution.advice}`,
        )
      }

      const verified: State = {
        ...state,
        phase: "adjudicate-step",
        image: event.image ?? state.image,
        pending: state.pending === undefined ? undefined : { ...state.pending, attribution },
      }
      // One adjudication call, two answers (§3): the prediction, and the next unsatisfied checkpoint.
      // 2.2's checkpoint score therefore comes out of the same image at no extra call.
      return ask(
        verified,
        ComputerPrompt.adjudicator({
          prediction: state.pending?.expect,
          checkpoint: state.spec.checkpoints[state.checkpointIndex],
          image: verified.image,
        }),
        "ask-adjudicator",
      )
    }

    // ── Settle ────────────────────────────────────────────────────────────────────────────────
    case "adjudicate-claim": {
      if (event.kind !== "adjudicated") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)
      const parsed = ComputerPrompt.parseAdjudication(event.text)
      // 🔴 G1 in one line: the claim is only ever confirmed by the harness's own adjudication of the
      // TERMINAL checkpoint. An unreadable reply, a `no`, or an answer the reader never gave all leave
      // the run exactly where it was — the model's say-so moves nothing.
      if (parsed.ok && parsed.reply.checkpoint === "yes") {
        const checkpoint = terminalCheckpoint(spent.spec)
        if (checkpoint === undefined)
          return voided(spent, "protocol", "a claim was adjudicated without a terminal checkpoint")
        return verifyOrContinue(spent, checkpoint, { kind: "claim" }, confirmClaim(spent))
      }
      const rejected = record(spent, {
        verdict: parsed.ok ? "claim REJECTED" : "claim unreadable",
      })
      return settle({ ...rejected, noProgress: rejected.noProgress + 1, pending: undefined })
    }

    case "adjudicate-step": {
      if (event.kind !== "adjudicated") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)
      const parsed = ComputerPrompt.parseAdjudication(event.text)
      const attribution = spent.pending?.attribution
      const advanced = parsed.ok && parsed.reply.checkpoint === "yes"

      const noEffect = attribution?.kind === "no-visible-effect"
      const signature = spent.pending?.signature
      // G13 — two consecutive no-effects on DIFFERENT targets is the autolock signature. The same
      // target twice is a stuck control, which is a different (and much less alarming) finding; the
      // repeat interlock means it should not be reachable at all.
      const consecutiveNoEffect = !noEffect
        ? 0
        : spent.consecutiveNoEffect > 0 && spent.lastNoEffect !== undefined && spent.lastNoEffect !== signature
          ? spent.consecutiveNoEffect + 1
          : 1

      const verdict = attribution === undefined ? "no verdict" : attribution.kind
      const predicted = parsed.ok && parsed.reply.predicted !== undefined ? `/pred:${parsed.reply.predicted}` : ""

      const measured: Measured = {
        verdict: `${verdict}${predicted}`,
        consecutiveNoEffect,
        ...(noEffect && signature !== undefined ? { lastNoEffect: signature } : {}),
        attributed: attribution?.kind === "attributed",
      }

      // 🔴 A CLAIMED checkpoint is not an awarded one. See the one-re-ask confirmation gate (`confirm-checkpoint` below) for the
      // measurement: on the near-miss frame that actually produced the 2.2 false positive this
      // question answers `yes` ~40% of the time and `no` the rest, at temperature 0, so a single
      // sample turned into a permanent advance is the defect. Nothing else about the step waits on
      // this — every measurement is already in `measured` — so a confirmation that never arrives
      // costs the award and not the step.
      if (advanced) {
        const confirming: State = { ...spent, phase: "confirm-checkpoint", confirming: measured, awarding: 1 }
        return ask(
          confirming,
          ComputerPrompt.adjudicator({
            // ⚠️ The checkpoint ALONE, deliberately. The prediction was answered by the first call
            // and re-asking it would spend a second answer on a settled question — and a prompt
            // that differs from the first is a *less* correlated sample, which is the direction
            // this guard wants.
            checkpoint: spent.spec.checkpoints[spent.checkpointIndex],
            image: spent.image,
          }),
          "ask-adjudicator",
        )
      }

      // 🔴 The battery is a PROGRESS MARKER, not a stopwatch. See the one-level lookahead (`lookahead-checkpoint` below): a run
      // that clears one screen per step outruns a one-question-per-frame ratchet, and the frame that
      // satisfies k+1 is gone by the time k lands. So when the next checkpoint says `no`, ask the one
      // AFTER it on the same frame — if that is true the run has already overshot, and the skipped
      // one is passed by the substrate's own monotone structure.
      const lookahead = spent.spec.checkpoints[spent.checkpointIndex + 1]
      if (lookahead !== undefined) {
        const probing: State = { ...spent, phase: "lookahead-checkpoint", confirming: measured }
        return ask(
          probing,
          ComputerPrompt.adjudicator({ checkpoint: lookahead, image: spent.image }),
          "ask-adjudicator",
        )
      }
      return settleMeasured(spent, measured, 0)
    }

    // ── Lookahead (the overshoot probe) ───────────────────────────────────────────────────────
    case "lookahead-checkpoint": {
      if (event.kind !== "adjudicated") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)
      const measured = state.confirming
      if (measured === undefined) {
        return voided(spent, "protocol", "a checkpoint lookahead arrived with no parked measurement to settle")
      }
      const parsed = ComputerPrompt.parseAdjudication(event.text)
      const overshot = parsed.ok && parsed.reply.checkpoint === "yes"
      if (!overshot) return settleMeasured(spent, measured, 0)
      // A lookahead award is a CANDIDATE like any other and gets the same confirmation gate — more
      // so, since it awards two checkpoints on one answer. `awarding: 2` is what the confirmation
      // then spends.
      const confirming: State = { ...spent, phase: "confirm-checkpoint", confirming: measured, awarding: 2 }
      return ask(
        confirming,
        ComputerPrompt.adjudicator({
          checkpoint: spent.spec.checkpoints[spent.checkpointIndex + 1],
          image: spent.image,
        }),
        "ask-adjudicator",
      )
    }

    // ── Confirm (the intermediate-checkpoint gate) ────────────────────────────────────────────
    case "confirm-checkpoint": {
      if (event.kind !== "adjudicated") return unexpected(state, event)
      const spent = spend(state, event.promptTokens)
      const measured = state.confirming
      // A harness bug, not a task outcome: the phase cannot be entered without parking a
      // measurement, so arriving here without one means the reducer was driven wrongly.
      if (measured === undefined) {
        return voided(spent, "protocol", "a checkpoint confirmation arrived with no parked measurement to settle")
      }
      const parsed = ComputerPrompt.parseAdjudication(event.text)
      // ⚠️ The third state again: an unreadable confirmation, or one the reader never answered, is
      // NOT a confirmation. `prompt.ts` argues the asymmetry — reading an unknown as `yes` declares
      // victory on a screen nobody looked at — and it binds here with more force, because this
      // question exists precisely to be the second opinion.
      const confirmed = parsed.ok && parsed.reply.checkpoint === "yes"
      if (!confirmed) return settleMeasured(spent, measured, 0, true)
      const awarding = state.awarding ?? 1
      const checkpoint = spent.spec.checkpoints[spent.checkpointIndex + awarding - 1]
      if (checkpoint === undefined)
        return voided(spent, "protocol", `checkpoint award ${awarding} has no target checkpoint`)
      return verifyOrContinue(
        spent,
        checkpoint,
        { kind: "step", measured, awarding },
        settleMeasured(spent, measured, awarding),
      )
    }

    // ── C4: executable state may veto, but never originate, a visual award. ───────────────────
    case "verify-checkpoint": {
      if (event.kind !== "checkpoint-verified") return unexpected(state, event)
      const continuation = state.verification
      if (continuation === undefined)
        return voided(state, "protocol", "a programmatic checkpoint verdict arrived without a continuation")
      if (event.result === "unavailable") {
        return blocked(
          state,
          "checkpoint-verifier-unavailable",
          `the declared checkpoint verifier is unavailable: ${event.evidence}`,
        )
      }
      if (continuation.kind === "claim") {
        if (event.result === "pass") return confirmClaim(state)
        const rejected = record({ ...state, verification: undefined }, { verdict: "claim verifier REJECTED" })
        return settle({ ...rejected, noProgress: rejected.noProgress + 1, pending: undefined })
      }
      return event.result === "pass"
        ? settleMeasured({ ...state, verification: undefined }, continuation.measured, continuation.awarding)
        : settleMeasured({ ...state, verification: undefined }, continuation.measured, 0, true)
    }
  }
}

/** Kick a run off. Equivalent to `next(initial(spec), {kind: "start"})`, and clearer at a call site. */
export const start = (spec: TaskSpec): Transition => next(initial(spec), { kind: "start" })
