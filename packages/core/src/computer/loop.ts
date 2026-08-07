export * as ComputerLoop from "./loop"

import { ComputerActions } from "./actions"
import { ComputerCoordinates } from "./coordinates"
import { ComputerEvidence } from "./evidence"
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
 * `claim_done` therefore does not transition anywhere: it schedules an adjudication and continues.
 * This is the jh completion gate's law with a screen as the witness instead of a command
 * (`todo.md`, run 3: unsatisfiable gate → `task_blocked: completion_unverified`).
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
 * Cost: one extra adjudication per CANDIDATE award, never per step. Raising this number lowers the
 * false rate further (the samples are near-independent) at one call each.
 */
export const CHECKPOINT_CONFIRMATIONS = 1

/** How many times one step may be re-prompted before the step is spent. G3: exactly one. */
export const REPAIRS_PER_STEP = 1

/**
 * 🔴 **How many ESCALATED re-prompts a repeat-refusal episode gets before the run stops. MEASURED,
 * 2026-08-07 — and the escalation is CHEAPER than what it replaces, not an extra call.**
 *
 * A structural repair says *"your reply was malformed"*; a repeat refusal says *"your reply was
 * well-formed and you are stuck"*. Until now both spent the same single {@link REPAIRS_PER_STEP} and
 * both ended the step the same way, and that conflation is what the 2.2 acceptance re-run ended on
 * (`computer-use-loop-plan.md` §7d). At Master of Magic's Game Options dialog the planner clicked
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
 * that names the CAUSE, the way `pointer-not-reaching-target` outranks `no-progress` in {@link settle}.
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
  | "pointer-not-reaching-target"
  /** The planner will not stop proposing an action G6 has refused — see {@link REPEAT_ESCALATIONS}. */
  | "stuck-on-refused-action"
  | "no-progress"
  | "cannot-see"
  | "capture-failed"
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

export type CapturePurpose = "calibrate" | "observe"

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
  | { readonly kind: "capture"; readonly scope: "frame"; readonly purpose: CapturePurpose }
  | { readonly kind: "ask-planner"; readonly prompt: ComputerPrompt.Prompt }
  | { readonly kind: "ask-adjudicator"; readonly prompt: ComputerPrompt.Prompt }
  | {
      readonly kind: "act"
      readonly action: ComputerActions.Action
      readonly argv: ReadonlyArray<ReadonlyArray<string>>
      readonly env: Readonly<Record<string, string>>
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
  | { readonly kind: "adjudicated"; readonly text: string; readonly promptTokens?: number }
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
  | "act"
  | "adjudicate-step"
  | "confirm-checkpoint"
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
  /** The newest frame, and ONLY the newest frame (G11). */
  readonly image?: ComputerPrompt.Image
  readonly pending?: Pending
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
  repairs: 0,
  consecutiveAbstains: 0,
  consecutiveNoEffect: 0,
  repeatEpisode: 0,
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
 * `n/m`, and `n/m?` when a checkpoint award was CLAIMED this step and the confirming re-ask did not
 * agree.
 *
 * ⚠️ **The marker lives in this column rather than in `verdict` because `verdict` is a ratcheted
 * field.** `FIELD_LIMIT.verdict` is 28 and the longest verdict the ladder can produce is
 * `needs-adjudication/pred:yes` at 27, pinned by `ledger.test.ts` against every attribution kind —
 * so appending anything there would start silently CLIPPING a measurement, which `ledger.ts` says
 * in-file is a lie about what was observed rather than an abbreviation. One character here costs
 * nothing and the planner still sees that its claim was refused.
 */
const checkpointColumn = (state: State, unconfirmed: boolean): string =>
  `${state.checkpointIndex}/${state.spec.checkpoints.length}${unconfirmed ? "?" : ""}`

const record = (state: State, fields: { readonly verdict: string; readonly unconfirmed?: boolean }): State => ({
  ...state,
  ledger: ComputerLedger.append(state.ledger, {
    n: state.step,
    observation: state.pending?.observation ?? ComputerLedger.ABSENT,
    action: state.pending?.summary ?? ComputerLedger.ABSENT,
    expect: state.pending?.expect ?? ComputerLedger.ABSENT,
    verdict: fields.verdict,
    checkpoint: checkpointColumn(state, fields.unconfirmed === true),
  }),
})

/** Emit a model call, spending the token counter first (G7 — the harness decrements, not the model). */
const ask = (state: State, prompt: ComputerPrompt.Prompt, kind: "ask-planner" | "ask-adjudicator"): Transition => {
  if (state.promptTokens >= state.spec.budget.maxPromptTokens) {
    return blocked(
      state,
      "budget",
      `prompt-token budget spent: ${state.promptTokens} of ${state.spec.budget.maxPromptTokens} after ${state.step} step(s)`,
    )
  }
  const estimate = ComputerPrompt.estimateTokens(prompt)
  const command: Command = kind === "ask-planner" ? { kind: "ask-planner", prompt } : { kind: "ask-adjudicator", prompt }
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
    // G13 — the autolock signature. Do not spend 25 steps discovering it.
    return blocked(
      state,
      "pointer-not-reaching-target",
      "two consecutive actions on DIFFERENT targets left their watch regions byte-identical. The " +
        "commands ran and the screen did not move where they aimed, which is what a captured pointer " +
        "looks like (DOSBox's `autolock` switches to relative motion after the first click, so the " +
        "host pointer moves correctly while the application's cursor does not follow). Fix the " +
        "substrate; do not adjust coordinates.",
    )
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
    state: { ...state, phase: "observe", step, repairs: 0, pending: undefined },
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
  readonly built: ComputerActions.Valid
  readonly watch?: ComputerActions.Region
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
  const offset = spec.pointerOffset
  return {
    ok: true,
    point: offset === undefined ? converted.point : { x: converted.point.x + offset.x, y: converted.point.y + offset.y },
  }
}

/**
 * The watch rectangle into pixels, by converting BOTH CORNERS.
 *
 * ⚠️ Converting the origin and then scaling width/height separately would round twice and can lose
 * the acted point out of the bottom-right of its own box. Converting corners keeps containment,
 * because `toPixels` is monotone non-decreasing per axis — the same property `watchContains` relies on
 * to do its check in the model's units at all.
 */
const toPixelRegion = (
  region: ComputerProposal.RegionDraft,
  spec: TaskSpec,
): { readonly ok: true; readonly region: ComputerActions.Region } | Refusal => {
  const topLeft = ComputerCoordinates.toPixels({ x: region.x, y: region.y }, spec.space, spec.viewport)
  if (!topLeft.ok) return { ok: false, reason: describeConversion(topLeft.error, "watch origin") }
  const bottomRight = ComputerCoordinates.toPixels(
    { x: region.x + region.width, y: region.y + region.height },
    spec.space,
    spec.viewport,
  )
  if (!bottomRight.ok) return { ok: false, reason: describeConversion(bottomRight.error, "watch far corner") }
  return {
    ok: true,
    region: {
      x: topLeft.point.x,
      y: topLeft.point.y,
      width: Math.max(1, bottomRight.point.x - topLeft.point.x),
      height: Math.max(1, bottomRight.point.y - topLeft.point.y),
    },
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
const buildAction = (draft: ComputerProposal.ProposalDraft, spec: TaskSpec): BuiltAction | Refusal => {
  const source = draft.action
  if (source == null) return { ok: false, reason: "no action" }
  const kind = typeof source.kind === "string" ? source.kind.trim() : ""
  if (!ComputerProposal.isActionKind(kind)) return { ok: false, reason: `not an action kind: ${kind || "(absent)"}` }

  let point: ComputerCoordinates.Point | undefined
  if (source.point != null) {
    const converted = toPixelPoint(source.point, spec, "action.point")
    if (!converted.ok) return converted
    point = converted.point
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

  if (draft.watch == null) return { ok: true, action, built }
  const watch = toPixelRegion(draft.watch, spec)
  if (!watch.ok) return watch
  return { ok: true, action, built, watch: watch.region }
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
    { ...state, repairs: state.repairs + 1 },
    ComputerPrompt.planner({ goal: state.spec.goal, ledger: state.ledger, image: state.image, note }),
    "ask-planner",
  )
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
const settleMeasured = (state: State, measured: Measured, advanced: boolean, unconfirmed = false): Transition => {
  const advancedState: State = {
    ...state,
    checkpointIndex: advanced ? state.checkpointIndex + 1 : state.checkpointIndex,
    consecutiveNoEffect: measured.consecutiveNoEffect,
    lastNoEffect: measured.lastNoEffect,
    // ⚠️ A REFUSED award is not progress. It reads as an advance to a casual reader and is exactly
    // the inflation this gate exists to stop, so it falls through to the `attributed` test like any
    // other step and increments `noProgress` when the screen did not move either.
    noProgress: advanced || measured.attributed ? 0 : state.noProgress + 1,
    confirming: undefined,
  }
  const logged = record(advancedState, { verdict: measured.verdict, unconfirmed })
  return settle({ ...logged, pending: undefined })
}

export function next(state: State, event: Event): Transition {
  if (state.phase === "terminal") {
    return { state, command: { kind: "finish", outcome: state.outcome ?? { kind: "void", reason: "protocol", detail: "already terminal" } } }
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
      if (!event.capture.ok) return blocked(state, "capture-failed", `the start frame was not captured: ${event.capture.reason}`)
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
      if (!event.capture.ok) return blocked(state, "capture-failed", `the observe frame was not captured: ${event.capture.reason}`)
      const observed: State = { ...state, phase: "propose", image: event.image }
      return ask(
        observed,
        ComputerPrompt.planner({ goal: state.spec.goal, ledger: state.ledger, image: event.image }),
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
      const build = buildAction(draft, spent.spec)
      if (!build.ok) {
        return reprompt(
          spent,
          `The harness REFUSED to execute your action: ${build.reason}\n\nRe-emit the WHOLE proposal, corrected.`,
          `refused: ${build.reason}`,
          described,
        )
      }
      const signature = JSON.stringify(build.built.argv)

      // G6 — the repeat interlock. `NO_EFFECT_ADVICE` is a sentence; this is the constraint.
      if (spent.lastNoEffect !== undefined && spent.lastNoEffect === signature) {
        // 🔴 The ESCALATION, not a retry. The first stuck step gets the plain refusal; a second one
        // gets a different question (see {@link REPEAT_ESCALATIONS}) and then the run stops.
        const note =
          spent.repeatEpisode === 0
            ? REPEAT_REFUSAL_NOTE
            : repeatEscalationNote({ action: described.summary, steps: spent.repeatEpisode + 1 })
        return reprompt(spent, note, "refused: repeat", described, { action: described.summary })
      }

      const acting: State = {
        ...spent,
        phase: "act",
        consecutiveAbstains: 0,
        repeatEpisode: 0,
        pending: { ...described, signature, kind: build.action.kind },
      }
      return {
        state: acting,
        command: {
          kind: "act",
          action: build.action,
          argv: build.built.argv,
          env: build.built.env,
          ...(build.watch === undefined ? {} : { watch: build.watch }),
        },
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
        const done: State = { ...spent, checkpointIndex: spent.spec.checkpoints.length }
        return settle(record(done, { verdict: "claim confirmed" }))
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

      // 🔴 A CLAIMED checkpoint is not an awarded one. See {@link CHECKPOINT_CONFIRMATIONS} for the
      // measurement: on the near-miss frame that actually produced the 2.2 false positive this
      // question answers `yes` ~40% of the time and `no` the rest, at temperature 0, so a single
      // sample turned into a permanent advance is the defect. Nothing else about the step waits on
      // this — every measurement is already in `measured` — so a confirmation that never arrives
      // costs the award and not the step.
      if (advanced) {
        const confirming: State = { ...spent, phase: "confirm-checkpoint", confirming: measured }
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
      return settleMeasured(spent, measured, false)
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
      return settleMeasured(spent, measured, confirmed, !confirmed)
    }
  }
}

/** Kick a run off. Equivalent to `next(initial(spec), {kind: "start"})`, and clearer at a call site. */
export const start = (spec: TaskSpec): Transition => next(initial(spec), { kind: "start" })
