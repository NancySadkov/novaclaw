import { describe, expect, test } from "bun:test"
import { ComputerLoop as LOOP } from "./loop"
import { ComputerEvidence as CE } from "./evidence"
import { ComputerActions } from "./actions"
import { ComputerProposal } from "./proposal"
import type { ComputerPrompt } from "./prompt"

/**
 * S4 — the reducer, driven by scripted event sequences.
 *
 * 🔴 **This is where the autolock class stops being a container.** On 2026-08-06 the finding that
 * DOSBox's `autolock=true` captures the pointer — grounding correct, `getmouselocation` correct,
 * process alive, click landing on nothing — cost a day inside a Docker image on the Spark. Here it is
 * two scripted `no-visible-effect` events, and the loop must name it rather than spending 25 steps.
 *
 * **Every terminal case in `computer-use-loop-plan.md` §2 is a test below**, and each one that
 * asserts a NEGATIVE (`not Done`, `never no-visible-effect`, `never act`) is paired with the
 * near-identical script that produces the positive — otherwise an absence assertion is green because
 * the outcome was unreachable, not because the guard fired.
 */

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

const CP9 = { id: "cp9", question: "Is a dialog headed 'Choose a new spell to research' visible?" }

const spec = (over: Partial<LOOP.TaskSpec> = {}): LOOP.TaskSpec => ({
  goal: "Start a new game of Master of Magic and end turn one.",
  checkpoints: [CP9],
  budget: { maxSteps: 8, maxPromptTokens: 500_000 },
  space: "normalized-1000",
  viewport: { width: 1280, height: 800 },
  actionOptions: { display: ":99", screenshotPath: "/tmp/novaclaw-cu.png" },
  ...over,
})

const image = (tag: string): ComputerPrompt.Image => ({ mime: "image/png", data: `BASE64_${tag}` })

const captured = (tag: string): LOOP.Event => ({
  kind: "captured",
  capture: CE.captured(`digest-${tag}`),
  image: image(tag),
})

const captureFailed = (reason: string): LOOP.Event => ({ kind: "captured", capture: CE.captureFailed(reason) })

/** A well-formed act proposal. `point` varies so successive steps have different signatures. */
const propose = (over: Record<string, unknown> = {}): LOOP.Event => ({
  kind: "planner-replied",
  text: JSON.stringify({
    observation: "the main menu",
    action: { kind: "click", button: "left", point: { x: 464, y: 684 } },
    expect: "The Game Options dialog is showing.",
    watch: { x: 440, y: 660, width: 60, height: 50 },
    ...over,
  }),
})

const proposeAt = (x: number, y: number): LOOP.Event =>
  propose({ action: { kind: "click", button: "left", point: { x, y } }, watch: { x: x - 20, y: y - 20, width: 40, height: 40 } })

const adjudged = (reply: Record<string, unknown>, promptTokens?: number): LOOP.Event => ({
  kind: "adjudicated",
  text: JSON.stringify({ observed: "a screen", ...reply }),
  ...(promptTokens === undefined ? {} : { promptTokens }),
})

const ok = CE.captured

/** The 08-06 shape: a quiet watch region while the frame moved. Reads as `no-visible-effect`. */
const quiet = (): CE.Input => ({
  kind: "click",
  watchIdlePair: [ok("84624392"), ok("84624392")],
  watchAfter: ok("84624392"),
  frameIdlePair: [ok("a34d5244"), ok("a34d5244")],
  frameAfter: ok("dc5020c7"),
})

/** The same shape with the watch region genuinely changed. Reads as `attributed`. */
const moved = (): CE.Input => ({ ...quiet(), watchAfter: ok("region-after") })

const acted = (evidence: CE.Input, tag = "after"): LOOP.Event => ({ kind: "acted", evidence, image: image(tag) })

interface Run {
  readonly commands: ReadonlyArray<LOOP.Command>
  readonly state: LOOP.State
  readonly last: LOOP.Command
  readonly outcome?: LOOP.Outcome
}

/** Feed a scripted event sequence. Stops early if the loop finishes. */
const drive = (task: LOOP.TaskSpec, events: ReadonlyArray<LOOP.Event>): Run => {
  let transition = LOOP.start(task)
  const commands: LOOP.Command[] = [transition.command]
  for (const event of events) {
    if (transition.command.kind === "finish") break
    transition = LOOP.next(transition.state, event)
    commands.push(transition.command)
  }
  return { commands, state: transition.state, last: transition.command, outcome: transition.state.outcome }
}

/** Calibration: capture the start frame, and the reader correctly answers `no` (G14). */
const CALIBRATE: ReadonlyArray<LOOP.Event> = [captured("start"), adjudged({ checkpoint: "no" })]

/**
 * One whole step: observe → propose → act → adjudicate, plus the CONFIRMATION when the step claims
 * a checkpoint.
 *
 * ⚠️ The confirmation event is appended automatically from the step's own `checkpoint` answer rather
 * than being passed at every call site, so a fixture cannot silently drift out of protocol — a step
 * that claims and is never confirmed would otherwise leave the reducer parked in
 * `confirm-checkpoint` and the failure would read as a missing command somewhere else entirely.
 * `confirm` overrides it, which is how the refusal cases are written.
 */
const step = (
  proposal: LOOP.Event,
  evidence: CE.Input,
  verdict: Record<string, unknown>,
  tag: string,
  confirm?: Record<string, unknown>,
): ReadonlyArray<LOOP.Event> => [
  captured(tag),
  proposal,
  acted(evidence, `${tag}-after`),
  adjudged(verdict),
  ...(verdict.checkpoint === "yes" ? [adjudged(confirm ?? { checkpoint: "yes" })] : []),
]

const commandKinds = (run: Run) => run.commands.map((c) => c.kind)

// ------------------------------------------------------------------------------------------------
// The clean run
// ------------------------------------------------------------------------------------------------

describe("a clean 3-step run reaches Done — and only through the harness's own adjudication", () => {
  const run = drive(spec(), [
    ...CALIBRATE,
    ...step(proposeAt(464, 684), moved(), { predicted: "yes", checkpoint: "no" }, "s1"),
    ...step(proposeAt(500, 600), moved(), { predicted: "yes", checkpoint: "no" }, "s2"),
    ...step(proposeAt(300, 400), moved(), { predicted: "yes", checkpoint: "yes" }, "s3"),
  ])

  test("it finishes Done with the terminal checkpoint satisfied", () => {
    expect(run.outcome).toEqual({
      kind: "done",
      detail: expect.stringContaining("cp9") as unknown as string,
      checkpointsSatisfied: 1,
    })
    expect(run.state.step).toBe(3)
  })

  test("the model never claimed anything — `Done` came from an adjudicated frame", () => {
    expect(run.state.ledger.map((e) => e.verdict)).toEqual([
      "attributed/pred:yes",
      "attributed/pred:yes",
      "attributed/pred:yes",
    ])
    expect(run.outcome?.kind === "done" && run.outcome.detail).toContain("harness-captured frame")
  })

  test("the command sequence is calibrate → (observe · plan · act · adjudicate) × 3 → confirm → finish", () => {
    expect(commandKinds(run)).toEqual([
      "capture",
      "ask-adjudicator",
      "capture",
      "ask-planner",
      "act",
      "ask-adjudicator",
      "capture",
      "ask-planner",
      "act",
      "ask-adjudicator",
      "capture",
      "ask-planner",
      "act",
      "ask-adjudicator",
      // The CONFIRMING re-ask, and it appears exactly once in a three-step run because only step 3
      // claimed a checkpoint. That is the whole cost model: per candidate award, never per step.
      "ask-adjudicator",
      "finish",
    ])
  })

  test("the ledger is one line per step and the planner sees only the newest frame", () => {
    expect(run.state.ledger).toHaveLength(3)
    expect(run.state.image).toEqual(image("s3-after"))
    const planners = run.commands.filter((c) => c.kind === "ask-planner")
    expect(planners).toHaveLength(3)
    for (const command of planners) {
      if (command.kind !== "ask-planner") continue
      expect(command.prompt.image).toBeDefined()
      expect(`${command.prompt.system}${command.prompt.user}`).not.toContain("BASE64")
    }
  })

  test("the act command carries exactly what `ComputerActions.build` produced", () => {
    const act = run.commands.find((c) => c.kind === "act")
    if (act?.kind !== "act") throw new Error("expected an act command")
    const built = ComputerActions.build({ kind: "click", button: "left", point: { x: 594, y: 547 } }, spec().actionOptions)
    if (!built.ok) throw new Error("fixture does not build")
    expect(act.argv).toEqual(built.argv)
    expect(act.env).toEqual({ DISPLAY: ":99" })
    // 464/1000 × 1280 = 594, 684/1000 × 800 = 547 — the P1 coordinate math, not a re-derivation.
    expect(act.action).toEqual({ kind: "click", button: "left", point: { x: 594, y: 547 } })
    expect(act.watch).toEqual({ x: 568, y: 531, width: 52, height: 32 })
  })
})

// ------------------------------------------------------------------------------------------------
// G13 — autolock
// ------------------------------------------------------------------------------------------------

describe("🔴 G13 — two no-visible-effects on DIFFERENT targets is the autolock signature", () => {
  const autolock = drive(spec(), [
    ...CALIBRATE,
    ...step(proposeAt(464, 684), quiet(), { predicted: "no", checkpoint: "no" }, "s1"),
    ...step(proposeAt(300, 200), quiet(), { predicted: "no", checkpoint: "no" }, "s2"),
    ...step(proposeAt(100, 100), moved(), { predicted: "yes", checkpoint: "no" }, "s3"),
  ])

  test("the run stops at step 2 and names the cause", () => {
    expect(autolock.outcome?.kind).toBe("blocked")
    if (autolock.outcome?.kind !== "blocked") return
    expect(autolock.outcome.reason).toBe("pointer-not-reaching-target")
    expect(autolock.outcome.detail).toContain("autolock")
    expect(autolock.state.step).toBe(2)
  })

  test("it does NOT spend the whole budget discovering it", () => {
    expect(autolock.state.step).toBeLessThan(spec().budget.maxSteps)
    expect(autolock.commands.filter((c) => c.kind === "act")).toHaveLength(2)
  })

  test("the negative control: the same two steps with the second one attributed keeps going", () => {
    const healthy = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), quiet(), { predicted: "no", checkpoint: "no" }, "s1"),
      ...step(proposeAt(300, 200), moved(), { predicted: "yes", checkpoint: "no" }, "s2"),
    ])
    expect(healthy.outcome).toBeUndefined()
    expect(healthy.state.ledger.map((e) => e.verdict)).toEqual(["no-visible-effect/pred:no", "attributed/pred:yes"])
  })

  test("a single no-visible-effect is not autolock — one is a finding, two is a diagnosis", () => {
    const once = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), quiet(), { predicted: "no", checkpoint: "no" }, "s1"),
    ])
    expect(once.outcome).toBeUndefined()
    expect(once.last.kind).toBe("capture")
  })
})

// ------------------------------------------------------------------------------------------------
// G7 — two hard counters
// ------------------------------------------------------------------------------------------------

describe("🔴 G7 — the budget is TWO hard counters and either one ends the run", () => {
  test("maxSteps: the step after the last affordable one is `Blocked(budget)`", () => {
    const run = drive(spec({ budget: { maxSteps: 2, maxPromptTokens: 500_000 } }), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), moved(), { checkpoint: "no" }, "s1"),
      ...step(proposeAt(300, 200), moved(), { checkpoint: "no" }, "s2"),
      ...step(proposeAt(100, 100), moved(), { checkpoint: "no" }, "s3"),
    ])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("budget")
    expect(run.outcome.detail).toContain("step budget")
    expect(run.state.step).toBe(2)
    expect(run.state.ledger).toHaveLength(2)
  })

  test("maxPromptTokens: the counter is spent from the wire's own usage and blocks mid-step", () => {
    const run = drive(spec({ budget: { maxSteps: 50, maxPromptTokens: 5_000 } }), [
      ...CALIBRATE,
      captured("s1"),
      { kind: "planner-replied", text: (propose() as { text: string }).text, promptTokens: 9_000 },
      acted(moved(), "s1-after"),
    ])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("budget")
    expect(run.outcome.detail).toContain("prompt-token budget")
    // It blocked before the adjudication call, not after — the harness decrements BEFORE the call.
    expect(run.commands.filter((c) => c.kind === "ask-adjudicator")).toHaveLength(1) // the calibration only
  })

  test("the negative control: the identical script under a real budget runs on", () => {
    const run = drive(spec({ budget: { maxSteps: 50, maxPromptTokens: 500_000 } }), [
      ...CALIBRATE,
      captured("s1"),
      { kind: "planner-replied", text: (propose() as { text: string }).text, promptTokens: 9_000 },
      acted(moved(), "s1-after"),
    ])
    expect(run.outcome).toBeUndefined()
    expect(run.last.kind).toBe("ask-adjudicator")
  })

  test("with no reported usage the estimate is spent instead, so the counter is never free", () => {
    const run = drive(spec(), [...CALIBRATE, captured("s1"), propose()])
    expect(run.state.promptTokens).toBeGreaterThan(1_000)
  })
})

// ------------------------------------------------------------------------------------------------
// Abstention
// ------------------------------------------------------------------------------------------------

describe("abstaining twice is `Blocked(cannot-see)` — and abstaining once is a legal answer", () => {
  const abstain: LOOP.Event = {
    kind: "planner-replied",
    text: JSON.stringify({ abstain: true, reason: "I cannot see the New Game button on this screen." }),
  }

  test("two in a row stop the run", () => {
    const run = drive(spec(), [...CALIBRATE, captured("s1"), abstain, captured("s2"), abstain])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("cannot-see")
    expect(run.state.ledger.map((e) => e.verdict)).toEqual(["abstained", "abstained"])
  })

  test("🔴 CONSECUTIVE, not cumulative: an action between them resets the counter (G12)", () => {
    const run = drive(spec(), [
      ...CALIBRATE,
      captured("s1"),
      abstain,
      ...step(proposeAt(464, 684), moved(), { checkpoint: "no" }, "s2"),
      captured("s3"),
      abstain,
    ])
    expect(run.outcome).toBeUndefined()
    expect(run.state.ledger).toHaveLength(3)
  })

  test("an abstention never becomes an `act` command — nothing is executed", () => {
    const run = drive(spec(), [...CALIBRATE, captured("s1"), abstain])
    expect(commandKinds(run)).not.toContain("act")
  })
})

// ------------------------------------------------------------------------------------------------
// G1 — Done is the harness's to declare
// ------------------------------------------------------------------------------------------------

describe("🔴 G1 — `claim_done` with no satisfied checkpoint is NOT Done", () => {
  const claim: LOOP.Event = {
    kind: "planner-replied",
    text: JSON.stringify({ claim_done: true, evidence: "The turn counter has advanced and the map is showing." }),
  }

  test("the model declares victory and the adjudicator says no — the run is not Done", () => {
    const run = drive(spec(), [...CALIBRATE, captured("s1"), claim, adjudged({ checkpoint: "no" })])
    expect(run.outcome).toBeUndefined()
    expect(run.state.checkpointIndex).toBe(0)
    expect(run.state.ledger.map((e) => e.verdict)).toEqual(["claim REJECTED"])
    // …and it went back to observing rather than terminating in either direction.
    expect(run.last.kind).toBe("capture")
  })

  test("🔴 the negative control: the SAME claim with an affirmative adjudication IS Done", () => {
    // Without this, the test above would be green because `Done` was unreachable in the fixture.
    const run = drive(spec(), [...CALIBRATE, captured("s1"), claim, adjudged({ checkpoint: "yes" })])
    expect(run.outcome?.kind).toBe("done")
  })

  test("the claim is an INPUT to the check: the model's evidence never reaches the reader", () => {
    const run = drive(spec(), [...CALIBRATE, captured("s1"), claim])
    const ask = run.last
    if (ask.kind !== "ask-adjudicator") throw new Error("expected an adjudication call")
    const rendered = `${ask.prompt.system}\n${ask.prompt.user}`
    expect(rendered).not.toContain("turn counter has advanced")
    expect(rendered).not.toContain("claim")
    // Control: the harness's OWN terminal question is what was asked.
    expect(rendered).toContain(CP9.question)
  })

  test("an unreadable adjudication of a claim leaves the run exactly where it was", () => {
    const run = drive(spec(), [
      ...CALIBRATE,
      captured("s1"),
      claim,
      { kind: "adjudicated", text: "I think it is finished, yes." },
    ])
    expect(run.outcome).toBeUndefined()
    expect(run.state.checkpointIndex).toBe(0)
    expect(run.state.ledger[0]?.verdict).toBe("claim unreadable")
  })

  test("🔴 a task with no terminal checkpoint terminates `Blocked(done-unverifiable)` and says so", () => {
    const run = drive(spec({ checkpoints: [] }), [captured("start")])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("done-unverifiable")
    expect(run.outcome.detail).toContain("failure of the task spec")
    // It costs nothing: not one capture, not one model call.
    expect(commandKinds(run)).toEqual(["finish"])
  })
})

// ------------------------------------------------------------------------------------------------
// G14 — calibration
// ------------------------------------------------------------------------------------------------

describe("🔴 G14 — a yes-machine adjudicator voids the run rather than scoring it", () => {
  test("the terminal checkpoint answered YES on the START frame is `Void`", () => {
    const run = drive(spec(), [captured("start"), adjudged({ checkpoint: "yes" })])
    expect(run.outcome?.kind).toBe("void")
    if (run.outcome?.kind !== "void") return
    expect(run.outcome.reason).toBe("adjudicator-uncalibrated")
    expect(run.outcome.detail).toContain("START frame")
    // Not one planner call was made, so no score exists to be misread as a result.
    expect(commandKinds(run)).not.toContain("ask-planner")
  })

  test("the negative control: `no` on the start frame proceeds to the first observation", () => {
    const run = drive(spec(), [...CALIBRATE])
    expect(run.outcome).toBeUndefined()
    expect(run.last).toEqual({ kind: "capture", scope: "frame", purpose: "observe" })
    expect(run.state.step).toBe(1)
  })

  test("an unreadable calibration reply is `Void` too — the channel was never calibrated", () => {
    const run = drive(spec(), [captured("start"), { kind: "adjudicated", text: "not json" }])
    expect(run.outcome?.kind).toBe("void")
    if (run.outcome?.kind !== "void") return
    expect(run.outcome.reason).toBe("adjudicator-unreadable")
  })
})

// ------------------------------------------------------------------------------------------------
// The intermediate-checkpoint confirmation gate
// ------------------------------------------------------------------------------------------------

/**
 * 🔴 **A claimed checkpoint is not an awarded one.** The 2.2 acceptance run awarded checkpoint 3 at
 * step 1 in all three runs on a frame where `CD MOM` had been typed but not executed, and in one run
 * it never became true at all — so the printed 3/9 was really 2/9. `CHECKPOINT_CONFIRMATIONS` carries
 * the measurement; this block is the mechanism.
 *
 * ⚠️ **Every refusal test here is paired with the near-identical script that AWARDS.** A gate that
 * refuses everything passes every negative assertion while being worse than no gate at all — it would
 * make the battery unscoreable rather than honest, which is the failure direction the live positive
 * control (true awards 25/25 → 25/25) was measured to rule out.
 */
describe("🔴 a checkpoint award is CONFIRMED before it counts", () => {
  const twoCheckpoints = spec({
    checkpoints: [{ id: "cp1", question: "Is the C:\\MOM> prompt showing?" }, CP9],
    noProgressLimit: 99,
  })

  /** A step that claims `cp1`, with the confirmation answer under the test's control. */
  const claiming = (confirm: Record<string, unknown>) =>
    drive(twoCheckpoints, [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), moved(), { predicted: "yes", checkpoint: "yes" }, "s1", confirm),
    ])

  test("POSITIVE CONTROL — a confirmed claim advances the checkpoint", () => {
    const run = claiming({ checkpoint: "yes" })
    expect(run.state.checkpointIndex).toBe(1)
    expect(run.state.ledger.at(-1)?.checkpoint).toBe("1/2")
  })

  test("a claim the confirming re-ask REFUSES advances nothing", () => {
    const run = claiming({ checkpoint: "no" })
    expect(run.state.checkpointIndex).toBe(0)
  })

  test("an UNREADABLE confirmation advances nothing either — never `yes` on an unanswered question", () => {
    const run = drive(twoCheckpoints, [
      ...CALIBRATE,
      captured("s1"),
      proposeAt(464, 684),
      acted(moved(), "s1-after"),
      adjudged({ predicted: "yes", checkpoint: "yes" }),
      { kind: "adjudicated", text: "the screen looks right to me" },
    ])
    expect(run.state.checkpointIndex).toBe(0)
  })

  test("a confirmation that ANSWERS NOTHING advances nothing — the third state, not a `yes`", () => {
    // Readable JSON, no `checkpoint` field at all. `parseAdjudication` returns ok with the answer
    // absent, so this exercises a different branch from the unreadable case above.
    const run = drive(twoCheckpoints, [
      ...CALIBRATE,
      captured("s1"),
      proposeAt(464, 684),
      acted(moved(), "s1-after"),
      adjudged({ predicted: "yes", checkpoint: "yes" }),
      { kind: "adjudicated", text: JSON.stringify({ observed: "a screen" }) },
    ])
    expect(run.state.checkpointIndex).toBe(0)
  })

  test("a REFUSED award is visible in the ledger, so the planner is not told it advanced", () => {
    expect(claiming({ checkpoint: "no" }).state.ledger.at(-1)?.checkpoint).toBe("0/2?")
    // …and the marker is absent when the award stood, or it would mean nothing.
    expect(claiming({ checkpoint: "yes" }).state.ledger.at(-1)?.checkpoint).toBe("1/2")
  })

  test("the confirmation asks the SAME checkpoint that was claimed, not the next one", () => {
    const asks = claiming({ checkpoint: "yes" }).commands.filter((c) => c.kind === "ask-adjudicator")
    const confirmation = asks.at(-1)
    if (confirmation?.kind !== "ask-adjudicator") throw new Error("expected a confirming adjudication")
    expect(confirmation.prompt.user).toContain("Is the C:\\MOM> prompt showing?")
    expect(confirmation.prompt.user).not.toContain(CP9.question)
  })

  test("G5 still holds on the SECOND call — the confirmation is blind, and carries no prediction", () => {
    const asks = claiming({ checkpoint: "yes" }).commands.filter((c) => c.kind === "ask-adjudicator")
    const confirmation = asks.at(-1)
    if (confirmation?.kind !== "ask-adjudicator") throw new Error("expected a confirming adjudication")
    const rendered = `${confirmation.prompt.system}${confirmation.prompt.user}`
    expect(rendered).not.toContain(twoCheckpoints.goal)
    expect(rendered).not.toContain("click")
    // The prediction is deliberately dropped: it was already answered, and a differently-shaped
    // prompt is a LESS correlated second sample, which is the direction this guard wants.
    expect(rendered).not.toContain("The Game Options dialog is showing.")
    expect(confirmation.prompt.user).not.toContain("STATEMENT")
    // Non-vacuity: the FIRST adjudication of that step did carry the prediction, so the assertions
    // above are about the confirmation and not about a prompt builder that never emits predictions.
    const first = asks.at(-2)
    if (first?.kind !== "ask-adjudicator") throw new Error("expected the step adjudication")
    expect(first.prompt.user).toContain("The Game Options dialog is showing.")
  })

  test("it costs ONE extra call, and only on a step that claims something", () => {
    const claimed = claiming({ checkpoint: "yes" }).commands.filter((c) => c.kind === "ask-adjudicator").length
    const quietRun = drive(twoCheckpoints, [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), moved(), { predicted: "yes", checkpoint: "no" }, "s1"),
    ])
    const unclaimed = quietRun.commands.filter((c) => c.kind === "ask-adjudicator").length
    expect(claimed - unclaimed).toBe(LOOP.CHECKPOINT_CONFIRMATIONS)
  })

  test("a refused award is NOT progress — it must not reset the no-progress counter", () => {
    // The screen did not move AND the award was refused, so the step advanced nothing at all. If a
    // refusal reset `noProgress` the run would be kept alive by its own rejected claims.
    const run = drive(spec({ checkpoints: [{ id: "cp1", question: "q1" }, CP9], noProgressLimit: 99 }), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), quiet(), { predicted: "yes", checkpoint: "yes" }, "s1", { checkpoint: "no" }),
    ])
    expect(run.state.noProgress).toBe(1)
  })

  test("the terminal checkpoint is gated too — a refused claim does not reach `Done`", () => {
    const run = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), moved(), { predicted: "yes", checkpoint: "yes" }, "s1", { checkpoint: "no" }),
    ])
    expect(run.outcome?.kind).not.toBe("done")
    // The pair: the identical script with the confirmation agreeing DOES finish, so the assertion
    // above is about the gate and not about an unreachable `Done`.
    const confirmed = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), moved(), { predicted: "yes", checkpoint: "yes" }, "s1"),
    ])
    expect(confirmed.outcome?.kind).toBe("done")
  })

  /**
   * ⚠️ **This test was VACUOUS in its first form and the mutation is what said so.** It asserted
   * `promptTokens >= 1300` after a run whose planner call alone estimates over a thousand (one image
   * is `IMAGE_PROMPT_TOKENS`), so the threshold was already met without the confirmation spending
   * anything — deleting the `spend` left it green. A budget assertion has to measure the DIFFERENCE
   * the call makes, not a total that other calls can satisfy on its own.
   */
  test("the confirmation SPENDS budget like any other call — G7 has no free calls", () => {
    const script = (confirmationTokens: number) => [
      ...CALIBRATE,
      captured("s1"),
      proposeAt(464, 684),
      acted(moved(), "s1-after"),
      adjudged({ predicted: "yes", checkpoint: "yes" }, 1_200),
      adjudged({ checkpoint: "yes" }, confirmationTokens),
    ]
    const cheap = drive(spec(), script(0))
    const dear = drive(spec(), script(1_300))
    expect(dear.state.promptTokens - cheap.state.promptTokens).toBe(1_300)
  })
})

// ------------------------------------------------------------------------------------------------
// G2 — a failed capture is never a no-visible-effect
// ------------------------------------------------------------------------------------------------

describe("🔴 G2 — a stale capture is `capture-failed`, NEVER `no-visible-effect`", () => {
  test("the after-capture fails and the loop refuses to read the stale digest as evidence", () => {
    // The forgery: `scrot -o` overwrites one path, so a failed capture leaves the previous frame and
    // its digest is byte-identical — which manufactures the strongest verdict the system has.
    const stale: CE.Input = { ...quiet(), watchAfter: CE.captureFailed("scrot exited 1") }
    const run = drive(spec(), [...CALIBRATE, captured("s1"), proposeAt(464, 684), acted(stale, "s1-after")])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("capture-failed")
    expect(run.outcome.detail).toContain("watchAfter")
    expect(run.outcome.detail).toContain("scrot -o")
    expect(run.state.ledger.map((e) => e.verdict)).not.toContain("no-visible-effect")
  })

  test("🔴 the negative control: the identical script with a REAL capture reads no-visible-effect", () => {
    // The verdict the failure would have forged is exactly this one, so the guard above cannot be
    // green by accident.
    const run = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), quiet(), { predicted: "no", checkpoint: "no" }, "s1"),
    ])
    expect(run.outcome).toBeUndefined()
    expect(run.state.ledger[0]?.verdict).toBe("no-visible-effect/pred:no")
  })

  test("a failed OBSERVE capture stops the run before a coordinate is grounded from nothing", () => {
    const run = drive(spec(), [...CALIBRATE, captureFailed("no such file")])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("capture-failed")
    expect(commandKinds(run)).not.toContain("ask-planner")
  })

  test("a failed START capture stops the run before calibration", () => {
    const run = drive(spec(), [captureFailed("display :99 not reachable")])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("capture-failed")
  })

  test("a failed FRAME capture is advisory and the step still produces a verdict", () => {
    const degraded: CE.Input = { ...quiet(), frameAfter: CE.captureFailed("scrot exited 1") }
    const run = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), degraded, { checkpoint: "no" }, "s1"),
    ])
    expect(run.outcome).toBeUndefined()
    expect(run.state.ledger[0]?.verdict).toContain("no-visible-effect")
  })
})

// ------------------------------------------------------------------------------------------------
// G6 — the repeat interlock
// ------------------------------------------------------------------------------------------------

describe("🔴 G6 — an action byte-identical to one that just did nothing is refused before execution", () => {
  const repeated = drive(spec(), [
    ...CALIBRATE,
    ...step(proposeAt(464, 684), quiet(), { predicted: "no", checkpoint: "no" }, "s1"),
    captured("s2"),
    proposeAt(464, 684),
  ])

  test("the identical proposal produces a re-prompt, not an act command", () => {
    expect(repeated.last.kind).toBe("ask-planner")
    if (repeated.last.kind !== "ask-planner") return
    expect(repeated.last.prompt.user).toContain("byte-identical")
    expect(repeated.commands.filter((c) => c.kind === "act")).toHaveLength(1)
  })

  test("🔴 the negative control: without the preceding no-effect the SAME repeat executes", () => {
    const fine = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), moved(), { checkpoint: "no" }, "s1"),
      captured("s2"),
      proposeAt(464, 684),
    ])
    expect(fine.last.kind).toBe("act")
  })

  test("a DIFFERENT target after a no-effect is allowed — the interlock is on repetition, not on retry", () => {
    const different = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), quiet(), { checkpoint: "no" }, "s1"),
      captured("s2"),
      proposeAt(300, 200),
    ])
    expect(different.last.kind).toBe("act")
  })

  test("the refusal costs the step once the single repair is spent (G3)", () => {
    const exhausted = drive(spec(), [
      ...CALIBRATE,
      ...step(proposeAt(464, 684), quiet(), { checkpoint: "no" }, "s1"),
      captured("s2"),
      proposeAt(464, 684),
      proposeAt(464, 684),
    ])
    expect(exhausted.state.ledger.map((e) => e.verdict)).toEqual(["no-visible-effect", "refused: repeat"])
    expect(exhausted.last.kind).toBe("capture")
  })
})

// ------------------------------------------------------------------------------------------------
// The Guard calls ComputerActions.build — S1's named, deferred hole
// ------------------------------------------------------------------------------------------------

describe("🔴 the Guard calls `ComputerActions.build`, which is where value-level validation lives", () => {
  /**
   * Each of these passes `structuralIssues` — S1 checks only that the payload FIELD is present,
   * deliberately, so there is one opinion about `xdotool`. If S4 skipped `build`, every one would be
   * executed against the substrate and fail at run time under a green suite: exactly the shape of
   * `xdotool --display`, a flag that does not exist, under 23 green tests.
   */
  const cases: ReadonlyArray<{ readonly name: string; readonly action: Record<string, unknown>; readonly says: string }> = [
    { name: "a keysym spec `build` rejects", action: { kind: "key", keys: "ctrl s" }, says: "keysym" },
    { name: "a scroll beyond MAX_SCROLL", action: { kind: "scroll", direction: "down", amount: 40 }, says: "exceeds" },
    { name: "an empty `type` string", action: { kind: "type", text: "" }, says: "nothing to type" },
  ]

  for (const testCase of cases) {
    test(`${testCase.name} never becomes an act command`, () => {
      const proposal: LOOP.Event = {
        kind: "planner-replied",
        text: JSON.stringify({ observation: "a screen", action: testCase.action, expect: "something changes" }),
      }
      // Control: S1 alone lets it through, so this test is about S4 and not about the schema.
      const parsed = JSON.parse((proposal as { text: string }).text) as Record<string, unknown>
      expect(parsed.action).toBeDefined()

      const run = drive(spec(), [...CALIBRATE, captured("s1"), proposal])
      expect(commandKinds(run)).not.toContain("act")
      expect(run.last.kind).toBe("ask-planner")
      if (run.last.kind !== "ask-planner") return
      // The refusal quotes `build`'s OWN words, so there is one opinion rather than a paraphrase.
      expect(run.last.prompt.user).toContain(testCase.says)
      expect(run.last.prompt.user).toContain("REFUSED")
    })
  }

  test("🔴 the negative control: the same actions, in range, DO reach the substrate", () => {
    for (const action of [
      { kind: "key", keys: "ctrl+s" },
      { kind: "scroll", direction: "down", amount: 3 },
      { kind: "type", text: "magic" },
    ]) {
      const run = drive(spec(), [
        ...CALIBRATE,
        captured("s1"),
        { kind: "planner-replied", text: JSON.stringify({ observation: "a screen", action, expect: "something changes" }) },
      ])
      expect(run.last.kind).toBe("act")
      if (run.last.kind !== "act") continue
      const built = ComputerActions.build(action as ComputerActions.Action, spec().actionOptions)
      if (!built.ok) throw new Error(`fixture does not build: ${built.reason}`)
      expect(run.last.argv).toEqual(built.argv)
    }
  })

  test("S1's schema really is silent about these — the hole was S4's to close, not S1's", () => {
    // If `structuralIssues` had rejected them, the tests above would be measuring S1's guard while
    // claiming to measure S4's, and removing the `build` call would leave them green.
    for (const action of [
      { kind: "key", keys: "ctrl s" },
      { kind: "scroll", direction: "down", amount: 40 },
      { kind: "type", text: "" },
    ]) {
      const issues = ComputerProposal.errorsOf(
        ComputerProposal.structuralIssues({ observation: "a screen", action, expect: "something changes" }),
      )
      expect(issues).toEqual([])
    }
  })
})

// ------------------------------------------------------------------------------------------------
// Coordinates — surfaced, never clamped (G8's behavioural half)
// ------------------------------------------------------------------------------------------------

describe("a coordinate outside the declared space is a refusal, never a clamp", () => {
  test("x = 1200 in `normalized-1000` is refused, and the message names the space it would fit", () => {
    const run = drive(spec(), [
      ...CALIBRATE,
      captured("s1"),
      propose({
        action: { kind: "click", button: "left", point: { x: 1200, y: 684 } },
        watch: { x: 1180, y: 660, width: 40, height: 50 },
      }),
    ])
    expect(commandKinds(run)).not.toContain("act")
    if (run.last.kind !== "ask-planner") throw new Error("expected a re-prompt")
    expect(run.last.prompt.user).toContain("outside the declared")
    expect(run.last.prompt.user).toContain("pixels")
  })

  test("the pointer offset is applied AFTER conversion, and never to the watch region", () => {
    const run = drive(spec({ pointerOffset: { x: -18, y: -8 } }), [
      ...CALIBRATE,
      captured("s1"),
      proposeAt(464, 684),
    ])
    if (run.last.kind !== "act") throw new Error("expected an act command")
    expect(run.last.action).toEqual({ kind: "click", button: "left", point: { x: 594 - 18, y: 547 - 8 } })
    // The change still appears where the model aimed, so the box is unmoved.
    expect(run.last.watch).toEqual({ x: 568, y: 531, width: 52, height: 32 })
  })
})

// ------------------------------------------------------------------------------------------------
// No progress, and protocol violations
// ------------------------------------------------------------------------------------------------

describe("the remaining terminal cases", () => {
  test("K consecutive steps with nothing attributed and no checkpoint is `Blocked(no-progress)`", () => {
    const inconclusive: CE.Input = {
      ...quiet(),
      watchIdlePair: [ok("a"), ok("b")],
      watchAfter: ok("c"),
    }
    const run = drive(spec({ noProgressLimit: 3, budget: { maxSteps: 20, maxPromptTokens: 900_000 } }), [
      ...CALIBRATE,
      ...step(proposeAt(100, 100), inconclusive, { checkpoint: "no" }, "s1"),
      ...step(proposeAt(200, 200), inconclusive, { checkpoint: "no" }, "s2"),
      ...step(proposeAt(300, 300), inconclusive, { checkpoint: "no" }, "s3"),
    ])
    expect(run.outcome?.kind).toBe("blocked")
    if (run.outcome?.kind !== "blocked") return
    expect(run.outcome.reason).toBe("no-progress")
    expect(run.state.ledger.map((e) => e.verdict)).toEqual([
      "needs-adjudication",
      "needs-adjudication",
      "needs-adjudication",
    ])
  })

  test("an attributed change resets the no-progress counter", () => {
    const inconclusive: CE.Input = { ...quiet(), watchIdlePair: [ok("a"), ok("b")], watchAfter: ok("c") }
    const run = drive(spec({ noProgressLimit: 3, budget: { maxSteps: 20, maxPromptTokens: 900_000 } }), [
      ...CALIBRATE,
      ...step(proposeAt(100, 100), inconclusive, { checkpoint: "no" }, "s1"),
      ...step(proposeAt(200, 200), moved(), { checkpoint: "no" }, "s2"),
      ...step(proposeAt(300, 300), inconclusive, { checkpoint: "no" }, "s3"),
    ])
    expect(run.outcome).toBeUndefined()
  })

  test("an exec failure is recorded and the loop re-observes rather than dying", () => {
    const run = drive(spec(), [
      ...CALIBRATE,
      captured("s1"),
      proposeAt(464, 684),
      { kind: "act-failed", reason: "xdotool: exit 1" },
    ])
    expect(run.outcome).toBeUndefined()
    expect(run.state.ledger[0]?.verdict).toContain("act-failed")
    expect(run.last.kind).toBe("capture")
  })

  test("an unreadable proposal gets exactly one repair, then costs the step (G3)", () => {
    const junk: LOOP.Event = { kind: "planner-replied", text: "I would click the New Game button." }
    const run = drive(spec(), [...CALIBRATE, captured("s1"), junk, junk])
    expect(run.state.ledger.map((e) => e.verdict)).toEqual(["unreadable reply"])
    expect(run.commands.filter((c) => c.kind === "ask-planner")).toHaveLength(2)
    expect(run.last.kind).toBe("capture")
  })

  test("a structurally invalid proposal is repaired with S1's own words", () => {
    const noExpect: LOOP.Event = {
      kind: "planner-replied",
      text: JSON.stringify({
        observation: "the main menu",
        action: { kind: "click", point: { x: 464, y: 684 } },
        watch: { x: 440, y: 660, width: 60, height: 50 },
      }),
    }
    const run = drive(spec(), [...CALIBRATE, captured("s1"), noExpect])
    if (run.last.kind !== "ask-planner") throw new Error("expected a repair")
    expect(run.last.prompt.user).toContain("`expect` is missing")
    expect(commandKinds(run)).not.toContain("act")
  })

  test("an event in a phase that cannot consume it is `Void(protocol)` — a harness bug, never a score", () => {
    const run = drive(spec(), [...CALIBRATE, captured("s1"), acted(moved(), "wrong")])
    expect(run.outcome?.kind).toBe("void")
    if (run.outcome?.kind !== "void") return
    expect(run.outcome.reason).toBe("protocol")
    expect(run.outcome.detail).toContain("propose")
  })

  test("a terminal state is idempotent — feeding it more events changes nothing", () => {
    const run = drive(spec({ checkpoints: [] }), [captured("start")])
    const again = LOOP.next(run.state, captured("more"))
    expect(again.state.outcome).toEqual(run.outcome!)
    expect(again.command).toEqual({ kind: "finish", outcome: run.outcome! })
  })
})

// ------------------------------------------------------------------------------------------------
// Purity
// ------------------------------------------------------------------------------------------------

describe("the reducer is pure: no I/O, no clock, and the same input twice is the same output", () => {
  test("`next` does not mutate the state it was given", () => {
    const first = LOOP.start(spec())
    const before = JSON.stringify(first.state)
    LOOP.next(first.state, captured("start"))
    expect(JSON.stringify(first.state)).toBe(before)
  })

  test("replaying the same event sequence twice produces identical states", () => {
    const script = [...CALIBRATE, ...step(proposeAt(464, 684), moved(), { checkpoint: "no" }, "s1")]
    expect(JSON.stringify(drive(spec(), script).state)).toBe(JSON.stringify(drive(spec(), script).state))
  })
})
