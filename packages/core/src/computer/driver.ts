export * as ComputerDriver from "./driver"

import { Duration, Effect } from "effect"
import { ComputerActions } from "./actions"
import { ComputerEvidence } from "./evidence"
import type { ComputerLedger } from "./ledger"
import { ComputerLoop } from "./loop"
import type { ComputerPrompt } from "./prompt"

/**
 * Computer Use 2.1 / S5 — the IMPURE BINDING. `JhEngine`'s shape: injected effects, a pure reducer,
 * and a report at the end.
 *
 * `loop.ts` is `next(state, event) -> {state, command}` with no I/O, no clock and no Effect. This
 * module is the other half: it interprets each command, performs the capture / exec / model call, and
 * feeds the result back as an event until the reducer says `finish`. Same seam
 * `packages/core/src/jh/engine.ts` is built on — a `Deps` record of injected `Effect`s, driven
 * in-process by a plan-repo harness the way `tests/jh-pi-smoke.ts` drives `JhEngine` — so the whole
 * run is verifiable **with fakes: no display, no model, no container.**
 *
 * It owns exactly two things the reducer cannot, and both are named guards:
 *
 * 🔴 **G2 — the capture freshness assertion. This is the most dangerous silent failure in the whole
 * design, and this file is where it is actually prevented.** `scrot -o` overwrites ONE reused path.
 * A capture that *fails* therefore leaves the PREVIOUS frame on disk, and its digest is identical to
 * the one before it — which forges `no-visible-effect`, the strongest evidence the system has, out of
 * a fault. S2 made the forgery *inexpressible in the type* (`ComputerEvidence.Capture` is tagged
 * `{ok:true,digest} | {ok:false,reason}`); S5 is what must **construct** the tag correctly. Four
 * independent conditions, each of which rejects on its own and each of which names itself:
 *
 * | # | condition | what it catches |
 * |---|---|---|
 * | 1 | the path is one **this run allocated for this capture alone**, never `actionOptions.screenshotPath` | the reuse that makes the forgery possible at all — a stale frame cannot be at a path nothing has written yet, and a concurrent `computer` tool call clobbers the shared path, not ours |
 * | 2 | the capture command exited **0** | the fault itself |
 * | 3 | a file **exists** at that path and is **non-empty** | an exit-0 that wrote nothing, and a truncated write |
 * | 4 | its mtime is **not older than the moment the command started** (± {@link FRESHNESS_TOLERANCE_MS}) | a leftover at a colliding path from an earlier run |
 *
 * ⚠️ **Condition 1 is the structural one and the other three are its backstops, not the reverse.**
 * Uniqueness is what makes "stale" mean *from a previous run* instead of *from the previous capture
 * milliseconds ago* — which is why the mtime tolerance can be generous without weakening anything. A
 * driver that kept the shared path and leaned on mtime alone would be comparing two timestamps a few
 * milliseconds apart with filesystem granularity in between, which is precisely the kind of *usually
 * right* check `coordinates.ts` argues is the worst possible property for a silent failure.
 *
 * ⚠️ **A pre-action watch capture that fails means the action is NOT executed.** Unstated in the
 * design, ruled here: the run is going to end `Blocked(capture-failed)` either way, so executing
 * would mutate a screen nobody can observe in exchange for nothing. The `watchAfter` slot then
 * carries {@link NOT_TAKEN} rather than a fabricated digest, so the report says *why* there is no
 * after-frame. (The FRAME pair stays advisory per `evidence.ts` — its failure degrades the note, it
 * does not stop the step.)
 *
 * 🔴 **G14 — the adjudicator calibration probe: the only thing in the design that can falsify the
 * design.** The reducer asks the *terminal* checkpoint question against the *start* frame, where the
 * answer is known to be **no**; a `yes` means the channel is a yes-machine and every verdict
 * downstream is noise, so the run terminates `Void(adjudicator-uncalibrated)` rather than producing a
 * score. The driver's part is to actually route that first ask through the same `ask` channel every
 * later verdict uses — a probe run through a *different* path would calibrate nothing — and to carry
 * the answer into {@link RunReport.calibration}, so 2.2 can tell a calibration from a verdict.
 *
 * ⚠️ **`usage.prompt_tokens` is the deliverable, and the report keeps MEASURED and ESTIMATED
 * apart.** S3 rendered the planner preamble at 494 by a 4-chars/token estimator and said plainly that
 * this is a character count, not the wire; §4's `P ≈ 800` is still a guess. {@link RunReport.usage} is
 * the per-call series with `promptTokens` present only when the response actually reported it, and
 * {@link Totals.fromWire} is false the moment any call did not. **A number cited from a report whose
 * `fromWire` is false is the estimator talking, not the wire.**
 */

// ---------------------------------------------------------------------------------------------
// The injected effects
// ---------------------------------------------------------------------------------------------

export type CaptureScope = "frame" | "watch"

/**
 * One capture, fully specified by the driver.
 *
 * The backend runs `argv` with `env` and reports what it finds — it makes no judgement about whether
 * the result is usable, because that judgement is G2 and G2 lives here.
 */
export interface CaptureRequest {
  /** The per-capture path THIS RUN allocated. Never the configured shared `screenshotPath`. */
  readonly path: string
  readonly scope: CaptureScope
  /** For the report: `calibrate`, `observe`, `watch-idle-a`, … */
  readonly label: string
  /** Absent = whole frame. */
  readonly region?: ComputerActions.Region
  /** Built by `ComputerActions.build` — the one opinion about `scrot`. */
  readonly argv: ReadonlyArray<ReadonlyArray<string>>
  readonly env: Readonly<Record<string, string>>
  /** Whether the caller needs the bytes as well as the digest (the frames the model is shown). */
  readonly wantsImage: boolean
}

/**
 * What the backend found at {@link CaptureRequest.path} after running the command.
 *
 * ⚠️ **The digest function is the backend's**, and it must be stable for the whole run — every
 * verdict in `verify.ts` is a string comparison between two of these. Two captures of identical
 * pixels must produce identical strings or the loop's only strong signal (unchanged) is destroyed.
 */
export interface CaptureFile {
  readonly digest: string
  readonly mtimeMs: number
  readonly size: number
  /**
   * Base64 payload + mime, when `wantsImage`.
   *
   * ⚠️ **Bare base64, never a `data:` URI** — `prompt.ts` records why: settlement builds the URI, so
   * a producer that emits one too yields `data:image/png;base64,data:image/png;base64,…`.
   */
  readonly image?: ComputerPrompt.Image
}

export interface CaptureOutcome {
  readonly exitCode: number
  readonly stderr?: string
  /** Absent = no file at the path at all. */
  readonly file?: CaptureFile
}

export interface ActRequest {
  readonly action: ComputerActions.Action
  /** Every array is handed to the ONE host-execution gate as an argv shape — never joined, never a shell. */
  readonly argv: ReadonlyArray<ReadonlyArray<string>>
  readonly env: Readonly<Record<string, string>>
}

export type ActOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface CheckpointVerifyRequest {
  readonly verifierID: string
  readonly checkpoint: ComputerLoop.Checkpoint
  readonly step: number
}

export type CheckpointVerifyOutcome =
  | { readonly result: "pass" | "fail"; readonly evidence: string }
  | { readonly result: "unavailable"; readonly evidence: string }

export type AskKind = "planner" | "grounder" | "preaction-critic" | "adjudicator"

export interface AskRequest {
  readonly kind: AskKind
  readonly prompt: ComputerPrompt.Prompt
}

/**
 * A model reply.
 *
 * ⚠️ **A transport failure is delivered to the reducer as an UNREADABLE reply, not as a new event
 * kind**, and that is the honest mapping rather than a shortcut: at the calibration it produces
 * `Void(adjudicator-unreadable)` — *the channel every verdict depends on was never calibrated* —
 * which is exactly true of a call that never came back. The failure is still named in
 * {@link UsageSample.failed} so a report never hides it behind a parse error.
 */
export type AskOutcome =
  | { readonly ok: true; readonly text: string; readonly promptTokens?: number }
  | { readonly ok: false; readonly reason: string }

export interface Deps {
  readonly capture: (request: CaptureRequest) => Effect.Effect<CaptureOutcome>
  readonly act: (request: ActRequest) => Effect.Effect<ActOutcome>
  readonly ask: (request: AskRequest) => Effect.Effect<AskOutcome>
  /** A positive executable-state result can confirm a visual award, never create one. */
  readonly verifyCheckpoint?: (request: CheckpointVerifyRequest) => Effect.Effect<CheckpointVerifyOutcome>
  /**
   * Directory the per-capture files go in — a path on the machine the DISPLAY lives on, so it is
   * joined with `/` and never with `node:path`.
   *
   * 🔴 **This is a measured trap in this repo, not caution.** A sibling's fault injector matched a
   * POSIX prefix against a `node:path` join and blocked nothing on win32, so two degradation tests
   * passed vacuously. The substrate is Linux inside a container while the instance may be a Windows
   * laptop; `path.join` here would emit `C:\…\tmp\x.png` and hand it to `scrot`.
   */
  readonly captureDir: string
  /** Distinguishes this run's capture files from every other run's. */
  readonly runId: string
  /**
   * Where each capture goes. Defaults to {@link capturePath}.
   *
   * ⚠️ **Injectable so the reuse refusal is REACHABLE.** The default allocator carries a monotonic
   * sequence number, so it can never hand back a path twice — which would make the check that
   * refuses a reused path dead code that no test can exercise, i.e. a guard nobody has ever seen
   * fire. A test supplies a constant allocator and watches it bite.
   */
  readonly capturePathFor?: (input: {
    readonly step: number
    readonly seq: number
    readonly label: string
    readonly extension: string
  }) => string
  /** Injected for determinism (`jh/engine.ts`'s `now`). Default `Date.now`. */
  readonly now?: () => number
  /** Injected so the settle re-capture costs a test nothing. Default: a real timer. */
  readonly sleep?: (ms: number) => Effect.Effect<void>
  readonly settleDelayMs?: number
  readonly freshnessToleranceMs?: number
  /** MECHANICAL hard stop, independent of the reducer's own budget. See {@link COMMANDS_PER_STEP_CEILING}. */
  readonly maxCommands?: number
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/**
 * How long to wait before the delayed watch re-capture that separates *slow* from *nothing*.
 * One of the two refinements that cost nothing: it buys a second look, not a second call.
 */
export const DEFAULT_SETTLE_DELAY_MS = 400

/**
 * How far in the past a capture file's mtime may be relative to the instant its command started.
 *
 * ⚠️ **This is a clock/granularity allowance, NOT the anti-staleness mechanism.** Uniqueness of the
 * path is what makes a within-run stale frame impossible; this only has to separate *this run* from
 * *some earlier run*, which is minutes or days, so a couple of seconds of slack costs nothing and
 * avoids a flake on a filesystem whose mtime resolution differs from the process clock.
 */
export const FRESHNESS_TOLERANCE_MS = 2_000

/**
 * The driver's own runaway stop, in commands per budgeted step.
 *
 * A clean pointer step is 7 commands (observe · planner · grounder · fresh capture · critic · act ·
 * adjudicator); a repaired one is 8–10. Non-pointer actions skip grounding and critique.
 * 12 is generous and still bounded — the thinking-budget RUNAWAY lesson is that every phase needs a
 * MECHANICAL hard stop that does not depend on the thing it is bounding being correct. If it trips,
 * the run is `Void(protocol)` (*do not score this*), never `Blocked` — a driver that cannot drive the
 * reducer to a terminal state is a harness bug, not a task outcome.
 */
export const COMMANDS_PER_STEP_CEILING = 12

/** The `watchAfter` slot when the action was refused because it could not have been observed. */
export const NOT_TAKEN =
  "not taken — a pre-action watch capture failed, so the action was NOT executed and the screen was " +
  "not touched. There is nothing to compare, and nothing happened to compare it against."

const SHARED_PATH_REFUSAL =
  "the loop tried to capture to the CONFIGURED screenshot path. That path is shared with the " +
  "`computer` tool and is overwritten in place, so a failed capture there leaves the previous frame " +
  "and its digest reads as an unchanged screen (G2). Every loop capture must go to a path the loop " +
  "owns for that one capture."

const REUSED_PATH_REFUSAL =
  "the loop allocated a capture path it had already written once in this run. A reused path is the " +
  "exact mechanism G2 exists to prevent."

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export interface CaptureRecord {
  readonly step: number
  readonly label: string
  readonly scope: CaptureScope
  readonly path: string
  /** Whether G2 accepted it. `false` ⇒ the loop was handed a `captureFailed`, never a digest. */
  readonly accepted: boolean
  /** Named for every rejection, so a run report says which of G2's conditions refused. */
  readonly reason?: string
  readonly exitCode?: number
  readonly mtimeMs?: number
  readonly size?: number
  /**
   * The backend's digest over the captured bytes — present whenever a file was found at all, so a
   * REJECTED capture carries the digest that G2 refused to believe as well.
   *
   * 🔴 **Without this the `RunReport` structurally cannot hold the evidence the loop exists to
   * produce.** Every verdict in `verify.ts` is a string comparison between two of these, and S7 had
   * to keep a parallel log in its harness because the report dropped them — which is exactly how the
   * "there is no measured region-after digest anywhere in this program" debt lasted two days.
   */
  readonly digest?: string
}

/**
 * One model call, as the wire reported it.
 *
 * 🔴 **`promptTokens` is present only when the response actually carried
 * `usage.prompt_tokens`.** `estimated` is always present and is the reducer's own 4-chars/token
 * seed. Keeping them in separate fields is the whole point of this slice: S3's 494 is a character
 * count and §4's `P ≈ 800` is a guess, and the way this program keeps finding such numbers wrong is
 * by conflating the two.
 */
export interface UsageSample {
  readonly step: number
  readonly call: AskKind
  /** The reducer phase that will consume the answer — `calibrate-adjudicate`, `propose`, … */
  readonly purpose: ComputerLoop.Phase
  readonly promptTokens?: number
  readonly estimated: number
  readonly withImage: boolean
  /** Present when the call itself failed; the reducer saw an empty (unreadable) reply. */
  readonly failed?: string
}

export interface VerdictRecord {
  readonly step: number
  readonly kind: ComputerEvidence.Attribution["kind"]
  readonly detail: string
}

export interface CheckpointScore {
  readonly id: string
  readonly question: string
  readonly satisfied: boolean
  readonly satisfiedAtStep?: number
}

export interface CheckpointVerificationRecord extends CheckpointVerifyRequest {
  readonly result: CheckpointVerifyOutcome["result"]
  readonly evidence: string
}

/**
 * G14's answer, derived from the reducer's own ruling rather than re-parsed here.
 *
 * `passed: false` is the *do not score this run* signal 2.2 needs — a checkpoint battery graded by an
 * uncalibrated channel is noise wearing a number.
 */
export interface Calibration {
  readonly asked: boolean
  /** What the reader said about the terminal checkpoint on the START frame. */
  readonly answer?: "yes" | "no"
  readonly readable: boolean
  readonly passed: boolean
}

export interface Totals {
  readonly calls: number
  readonly measuredCalls: number
  /** Σ of the reported `usage.prompt_tokens`. Only meaningful beside {@link measuredCalls}. */
  readonly reported: number
  /** Σ of the estimator. */
  readonly estimated: number
  /** What the reducer actually spent: reported where available, estimated otherwise. */
  readonly counted: number
  /** True only when EVERY call reported real prompt tokens. */
  readonly fromWire: boolean
}

export interface RunReport {
  readonly outcome: ComputerLoop.Outcome
  readonly steps: number
  /** The append-only step log, exactly as the planner saw it. */
  readonly ledger: ComputerLedger.Ledger
  readonly verdicts: ReadonlyArray<VerdictRecord>
  readonly checkpoints: ReadonlyArray<CheckpointScore>
  readonly checkpointsSatisfied: number
  /** Every executable-state veto, including explicit resolver absence. */
  readonly checkpointVerifications: ReadonlyArray<CheckpointVerificationRecord>
  readonly calibration: Calibration
  /** The per-call `usage.prompt_tokens` series — the number §4 asked to have measured. */
  readonly usage: ReadonlyArray<UsageSample>
  readonly promptTokens: Totals
  readonly captures: ReadonlyArray<CaptureRecord>
  readonly captureFailures: number
  /** How many actions actually executed. */
  readonly acted: number
  readonly commands: number
  readonly finalState: ComputerLoop.State
}

// ---------------------------------------------------------------------------------------------
// Path allocation
// ---------------------------------------------------------------------------------------------

/**
 * The extension decides the format `scrot` writes, so it is taken from the operator's own configured
 * path rather than assumed.
 */
export const extensionOf = (screenshotPath: string): string => {
  const dot = screenshotPath.lastIndexOf(".")
  const slash = Math.max(screenshotPath.lastIndexOf("/"), screenshotPath.lastIndexOf("\\"))
  if (dot <= slash + 1) return "png"
  const extension = screenshotPath.slice(dot + 1).trim()
  return /^[A-Za-z0-9]+$/.test(extension) ? extension.toLowerCase() : "png"
}

/**
 * `<dir>/<runId>-s<step>-c<seq>-<label>.<ext>` — joined with `/` on purpose (see {@link Deps.captureDir}).
 *
 * Deterministic, so a test can predict the exact path the driver will allocate and therefore
 * exercise the shared-path refusal instead of asserting it can never happen.
 */
export const capturePath = (input: {
  readonly captureDir: string
  readonly runId: string
  readonly step: number
  readonly seq: number
  readonly label: string
  readonly extension: string
}): string => {
  const dir = input.captureDir.replace(/[/\\]+$/, "")
  return `${dir}/${input.runId}-s${input.step}-c${input.seq}-${input.label}.${input.extension}`
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

interface Taken {
  readonly capture: ComputerEvidence.Capture
  readonly image?: ComputerPrompt.Image
}

export function run(spec: ComputerLoop.TaskSpec, deps: Deps): Effect.Effect<RunReport> {
  return Effect.gen(function* () {
    const now = deps.now ?? (() => Date.now())
    const sleep = deps.sleep ?? ((ms: number) => Effect.sleep(Duration.millis(ms)))
    const settleDelayMs = deps.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS
    const tolerance = deps.freshnessToleranceMs ?? FRESHNESS_TOLERANCE_MS
    const maxCommands = deps.maxCommands ?? (spec.budget.maxSteps + 2) * COMMANDS_PER_STEP_CEILING
    const extension = extensionOf(spec.actionOptions.screenshotPath)

    const captures: CaptureRecord[] = []
    const usage: UsageSample[] = []
    const verdicts: VerdictRecord[] = []
    const satisfiedAt = new Map<string, number>()
    const checkpointVerifications: CheckpointVerificationRecord[] = []
    const usedPaths = new Set<string>()
    let seq = 0
    let acted = 0
    let calibrationAsked = false

    // ── G2 ────────────────────────────────────────────────────────────────────────────────────
    const freshCapture = (input: {
      readonly step: number
      readonly scope: CaptureScope
      readonly label: string
      readonly region?: ComputerActions.Region
      readonly wantsImage: boolean
    }): Effect.Effect<Taken> =>
      Effect.gen(function* () {
        seq += 1
        const path =
          deps.capturePathFor?.({ step: input.step, seq, label: input.label, extension }) ??
          capturePath({
            captureDir: deps.captureDir,
            runId: deps.runId,
            step: input.step,
            seq,
            label: input.label,
            extension,
          })
        const reject = (reason: string, outcome?: CaptureOutcome): Taken => {
          captures.push({
            step: input.step,
            label: input.label,
            scope: input.scope,
            path,
            accepted: false,
            reason,
            ...(outcome === undefined ? {} : { exitCode: outcome.exitCode }),
            ...(outcome?.file === undefined
              ? {}
              : { mtimeMs: outcome.file.mtimeMs, size: outcome.file.size, digest: outcome.file.digest }),
          })
          return { capture: ComputerEvidence.captureFailed(reason) }
        }

        // Condition 1 — the path. Checked before anything is executed, because a capture written to
        // the shared path has already destroyed the evidence by the time it returns.
        if (path === spec.actionOptions.screenshotPath) return reject(SHARED_PATH_REFUSAL)
        if (usedPaths.has(path)) return reject(REUSED_PATH_REFUSAL)
        usedPaths.add(path)

        const built = ComputerActions.build(
          { kind: "screenshot", ...(input.region === undefined ? {} : { region: input.region }) },
          { ...spec.actionOptions, screenshotPath: path },
        )
        if (!built.ok) return reject(`the capture command could not be built: ${built.reason}`)

        const startedAt = now()
        const outcome = yield* deps.capture({
          path,
          scope: input.scope,
          label: input.label,
          ...(input.region === undefined ? {} : { region: input.region }),
          argv: built.argv,
          env: built.env,
          wantsImage: input.wantsImage,
        })

        // Condition 2 — the fault itself.
        if (outcome.exitCode !== 0) {
          const stderr =
            outcome.stderr === undefined || outcome.stderr.trim() === "" ? "" : `: ${outcome.stderr.trim()}`
          return reject(`the capture command exited ${outcome.exitCode}${stderr}`, outcome)
        }
        // Condition 3 — a file, with bytes in it.
        if (outcome.file === undefined)
          return reject(`the capture command exited 0 but wrote no file at ${path}`, outcome)
        if (!(outcome.file.size > 0))
          return reject(`the capture at ${path} is empty (${outcome.file.size} bytes)`, outcome)
        // Condition 4 — and it is this run's, not a leftover.
        if (outcome.file.mtimeMs < startedAt - tolerance) {
          return reject(
            `the file at ${path} is STALE: last modified ${startedAt - outcome.file.mtimeMs}ms before the ` +
              `capture command started, so it was written by something other than this capture`,
            outcome,
          )
        }

        captures.push({
          step: input.step,
          label: input.label,
          scope: input.scope,
          path,
          accepted: true,
          exitCode: outcome.exitCode,
          mtimeMs: outcome.file.mtimeMs,
          size: outcome.file.size,
          digest: outcome.file.digest,
        })
        return {
          capture: ComputerEvidence.captured(outcome.file.digest),
          ...(outcome.file.image === undefined ? {} : { image: outcome.file.image }),
        }
      })

    // ── The four-capture protocol ─────────────────────────────────────────────────────────────
    const performAct = (
      command: Extract<ComputerLoop.Command, { kind: "act" }>,
      state: ComputerLoop.State,
    ): Effect.Effect<ComputerLoop.Event> =>
      Effect.gen(function* () {
        const step = state.step
        const region = command.watch
        const scope: CaptureScope = region === undefined ? "frame" : "watch"
        const watchAt = (label: string, wantsImage = false) =>
          freshCapture({ step, scope, label, ...(region === undefined ? {} : { region }), wantsImage })

        // 🔴 ORDER IS THE PROTOCOL. `ComputerVerify.sampled()` requires (idle, idle, act, after) with
        // NOTHING between the idle pair, so the frame pair is taken FIRST and the watch pair last —
        // as late as possible, which is what makes it measure animation at the moment of acting
        // rather than a moment earlier.
        const frameIdleA = yield* freshCapture({ step, scope: "frame", label: "frame-idle-a", wantsImage: false })
        const frameIdleB = yield* freshCapture({ step, scope: "frame", label: "frame-idle-b", wantsImage: false })
        const watchIdleA = yield* watchAt("watch-idle-a")
        const watchIdleB = yield* watchAt("watch-idle-b")

        const frameIdlePair = [frameIdleA.capture, frameIdleB.capture] as const
        const watchIdlePair = [watchIdleA.capture, watchIdleB.capture] as const

        // The pre-action refusal: an action that cannot be observed is not executed. The frame pair
        // is advisory (`evidence.ts` ruling 3) and does NOT gate this.
        if (!watchIdleA.capture.ok || !watchIdleB.capture.ok) {
          return {
            kind: "acted",
            evidence: {
              kind: command.action.kind,
              watchIdlePair,
              watchAfter: ComputerEvidence.captureFailed(NOT_TAKEN),
              frameIdlePair,
              frameAfter: ComputerEvidence.captureFailed(NOT_TAKEN),
            },
          }
        }

        const outcome = yield* deps.act({
          action: command.action,
          argv: command.execution.argv,
          env: command.execution.env,
        })
        if (!outcome.ok) return { kind: "act-failed", reason: outcome.reason }
        acted += 1

        const watchAfter = yield* watchAt("watch-after")
        const frameAfter = yield* freshCapture({ step, scope: "frame", label: "frame-after", wantsImage: true })

        // §3's first refinement, taken ONLY when it can change an answer: `attribute()` consults the
        // settle capture on the `no-visible-effect` branch and nowhere else, so paying a delay after
        // a region that already moved would buy a field nobody reads.
        const before = watchIdleB.capture.ok ? watchIdleB.capture.digest : undefined
        let watchSettled: ComputerEvidence.Capture | undefined
        if (watchAfter.capture.ok && before !== undefined && watchAfter.capture.digest === before) {
          yield* sleep(settleDelayMs)
          watchSettled = (yield* watchAt("watch-settled")).capture
        }

        return {
          kind: "acted",
          evidence: {
            kind: command.action.kind,
            watchIdlePair,
            watchAfter: watchAfter.capture,
            frameIdlePair,
            frameAfter: frameAfter.capture,
            ...(watchSettled === undefined ? {} : { watchSettled }),
          },
          ...(frameAfter.image === undefined ? {} : { image: frameAfter.image }),
        }
      })

    // ── One command ───────────────────────────────────────────────────────────────────────────
    const perform = (command: ComputerLoop.Command, state: ComputerLoop.State): Effect.Effect<ComputerLoop.Event> =>
      Effect.gen(function* () {
        switch (command.kind) {
          case "capture": {
            const taken = yield* freshCapture({
              step: state.step,
              scope: command.scope,
              label: command.purpose,
              ...(command.region === undefined ? {} : { region: command.region }),
              wantsImage: true,
            })
            return {
              kind: "captured",
              capture: taken.capture,
              ...(taken.image === undefined ? {} : { image: taken.image }),
            }
          }
          case "ask-planner":
          case "ask-grounder":
          case "ask-preaction-critic":
          case "ask-adjudicator": {
            const kind: AskKind =
              command.kind === "ask-planner"
                ? "planner"
                : command.kind === "ask-grounder"
                  ? "grounder"
                  : command.kind === "ask-preaction-critic"
                    ? "preaction-critic"
                    : "adjudicator"
            // G14 — the calibration probe rides the SAME channel every later verdict uses. A probe
            // routed elsewhere would calibrate a channel the run does not use.
            if (state.phase === "calibrate-adjudicate") calibrationAsked = true
            const answer = yield* deps.ask({ kind, prompt: command.prompt })
            usage.push({
              step: state.step,
              call: kind,
              purpose: state.phase,
              estimated: state.lastPromptEstimate,
              withImage: command.prompt.image !== undefined,
              ...(answer.ok && answer.promptTokens !== undefined ? { promptTokens: answer.promptTokens } : {}),
              ...(answer.ok ? {} : { failed: answer.reason }),
            })
            const text = answer.ok ? answer.text : ""
            const promptTokens = answer.ok ? answer.promptTokens : undefined
            const tokens = promptTokens === undefined ? {} : { promptTokens }
            return kind === "planner"
              ? { kind: "planner-replied", text, ...tokens }
              : kind === "grounder"
                ? { kind: "grounder-replied", text, ...tokens }
                : kind === "preaction-critic"
                  ? { kind: "preaction-critiqued", text, ...tokens }
                : { kind: "adjudicated", text, ...tokens }
          }
          case "verify-checkpoint": {
            const request: CheckpointVerifyRequest = {
              verifierID: command.verifierID,
              checkpoint: command.checkpoint,
              step: state.step,
            }
            const outcome: CheckpointVerifyOutcome =
              deps.verifyCheckpoint === undefined
                ? {
                    result: "unavailable",
                    evidence: `no resolver is installed for ${command.verifierID}`,
                  }
                : yield* deps.verifyCheckpoint(request)
            checkpointVerifications.push({ ...request, ...outcome })
            return { kind: "checkpoint-verified", ...outcome }
          }
          case "act":
            return yield* performAct(command, state)
          case "finish":
            // Unreachable: the loop below stops on `finish`. Reported as a protocol fault rather
            // than silently ignored — a driver that reaches here is not driving this reducer.
            return { kind: "act-failed", reason: "the driver was asked to perform a finish command" }
        }
      })

    // ── Drive ─────────────────────────────────────────────────────────────────────────────────
    let transition = ComputerLoop.start(spec)
    let commands = 1
    let checkpointIndex = transition.state.checkpointIndex
    let capped = false

    while (transition.command.kind !== "finish") {
      if (commands >= maxCommands) {
        capped = true
        break
      }
      const before = transition.state
      const event = yield* perform(transition.command, before)
      transition = ComputerLoop.next(before, event)
      commands += 1

      // Verdicts are READ off the reducer, never recomputed — `attribute()` runs inside it, and a
      // second call site would be a second opinion about the same evidence.
      if (event.kind === "acted") {
        const attribution = transition.state.pending?.attribution
        if (attribution !== undefined) {
          verdicts.push({ step: before.step, kind: attribution.kind, detail: describeAttribution(attribution) })
        } else if (
          transition.state.outcome?.kind === "blocked" &&
          transition.state.outcome.reason === "capture-failed"
        ) {
          verdicts.push({ step: before.step, kind: "capture-failed", detail: transition.state.outcome.detail })
        }
      }
      if (transition.state.checkpointIndex > checkpointIndex) {
        for (let i = checkpointIndex; i < transition.state.checkpointIndex; i += 1) {
          const checkpoint = spec.checkpoints[i]
          if (checkpoint !== undefined && !satisfiedAt.has(checkpoint.id)) satisfiedAt.set(checkpoint.id, before.step)
        }
        checkpointIndex = transition.state.checkpointIndex
      }
    }

    const finalState = transition.state
    const outcome: ComputerLoop.Outcome = capped
      ? {
          kind: "void",
          reason: "protocol",
          detail:
            `the driver issued ${commands} commands without the reducer reaching a terminal state ` +
            `(cap ${maxCommands}). That is a harness fault, so this run is NOT scored.`,
        }
      : (finalState.outcome ?? {
          kind: "void",
          reason: "protocol",
          detail: "the reducer emitted `finish` without an outcome",
        })

    const measuredCalls = usage.filter((sample) => sample.promptTokens !== undefined).length
    const promptTokens: Totals = {
      calls: usage.length,
      measuredCalls,
      reported: usage.reduce((sum, sample) => sum + (sample.promptTokens ?? 0), 0),
      estimated: usage.reduce((sum, sample) => sum + sample.estimated, 0),
      counted: usage.reduce((sum, sample) => sum + (sample.promptTokens ?? sample.estimated), 0),
      fromWire: usage.length > 0 && measuredCalls === usage.length,
    }

    const uncalibrated = outcome.kind === "void" && outcome.reason === "adjudicator-uncalibrated"
    const unreadable = outcome.kind === "void" && outcome.reason === "adjudicator-unreadable"
    const calibration: Calibration = {
      asked: calibrationAsked,
      readable: calibrationAsked && !unreadable,
      passed: calibrationAsked && !uncalibrated && !unreadable,
      ...(uncalibrated ? { answer: "yes" as const } : calibrationAsked && !unreadable ? { answer: "no" as const } : {}),
    }

    return {
      outcome,
      steps: finalState.step,
      ledger: finalState.ledger,
      verdicts,
      checkpoints: spec.checkpoints.map((checkpoint, index) => ({
        id: checkpoint.id,
        question: checkpoint.question,
        satisfied: index < finalState.checkpointIndex,
        ...(satisfiedAt.has(checkpoint.id) ? { satisfiedAtStep: satisfiedAt.get(checkpoint.id)! } : {}),
      })),
      checkpointsSatisfied: finalState.checkpointIndex,
      checkpointVerifications,
      calibration,
      usage,
      promptTokens,
      captures,
      captureFailures: captures.filter((record) => !record.accepted).length,
      acted,
      commands,
      finalState,
    }
  })
}

/** One line per verdict for the report — the ladder's own words, never a re-derivation. */
const describeAttribution = (attribution: ComputerEvidence.Attribution): string => {
  switch (attribution.kind) {
    case "attributed":
      return attribution.late ? "the watch region changed, on the delayed settle capture" : "the watch region changed"
    case "no-visible-effect":
      return attribution.corroboratedByFrame
        ? "the watch region is byte-identical while the rest of the screen moved"
        : "the watch region is byte-identical"
    case "needs-adjudication":
    case "inconclusive":
      return attribution.reason
    case "capture-failed":
      return attribution.failed.map((f) => `${f.capture} (${f.reason})`).join(", ")
  }
}
