export * as JhEngine from "./engine"

// jh — the eval loop (jh.md §6c operational semantics). The DETERMINISTIC CONTROLLER: it owns the
// tree, the per-step minimal context, the verify gate, the retry budgets, and the log; the model is
// called only to introspect (fill the schema) and to correct (repair a failed leaf). Runs over injected
// deps (D6) — no services, no LLM/fs/shell imports here. NEVER fails: any model/tool/verifier failure
// becomes data (a blocked report is the worst case, rule §0.7.5); only our own invariant violations
// could defect.
//
// The loop (spec — implemented below):
//   runTask: create/resume root (pending); loop { step-budget guard; node = nextPending;
//     none → root committed ? done : blocked; else process(node) }
//   process(node): B introspect (≤2 tries: llm/parse/structural retry-once-then-block) → fill;
//     C if needs_decomposition → validate law-7 (one repair) → attach (else block);
//     D else force-split check → forceDecompose or cannot_split;
//     E else atomic loop { action → observe → verify; pass → commit + bubble; fail → budget?
//       exhausted → forceDecompose|block(budget); else write_file→corrector / other→re-introspect }.

import { Effect, Exit } from "effect"
import { Hash } from "../util/hash"
import { JhTree } from "./tree"
import { JhStep } from "./step"
import { JhDataflow } from "./dataflow"
import { JhContext } from "./context"
import { JhBudget } from "./budget"
import { JhVerifier } from "./verifier"
import { JhExpander } from "./expander"
import { JhStaleness } from "./staleness"
import { JhRegression } from "./regression"
import { JhLadder } from "./ladder"
import { JhLog } from "./log"
import type { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import type { JhArtifact } from "./artifact"

export interface LLMFail {
  readonly message: string
}

export interface Deps {
  readonly introspect: (p: JhExpander.PromptPair) => Effect.Effect<string, LLMFail>
  readonly correct: (p: JhExpander.PromptPair) => Effect.Effect<string, LLMFail>
  /**
   * improve19 (owner design, `notes/jh-think-stage.md`) — the THINK/DO split. Optional REASONING
   * stage: given the same context the introspect gets, return a SHORT free-form plan for this step.
   * The plan is injected into the following introspect prompt, so reasoning and schema-filling never
   * compete inside one call.
   *
   * Why this exists: jh disabled the `<think>` channel in wave 1 because a reasoning model "burns the
   * entire token budget in `<think>` and returns EMPTY content" — reasoning and JSON formatting fight
   * for one reply. Aider hit the identical wall ("strong at reasoning, but often fail to output
   * properly formatted code editing instructions") and SPLIT the roles instead of amputating —
   * architect + editor = 85% SOTA on their benchmark. This seam is that split, per step: the think
   * call has no JSON to lose, the do call has no reasoning to run away with.
   *
   * The caller owns the model and sampling — so `think` may run a STRONGER model (or the same model
   * with thinking ON) while `introspect`/`correct` run a cheaper one. Failure or an empty plan is
   * NEVER fatal: the engine falls through to the unplanned path (never-dead-end).
   */
  readonly think?: (p: JhExpander.PromptPair) => Effect.Effect<string, LLMFail>
  /** Which step kinds get a think stage (default: all three). `notes/jh-think-stage.md` argues the
   *  wall goes to decomposition + recovery, so a cost-sensitive caller can narrow to those. */
  readonly thinkOn?: ReadonlyArray<"decompose" | "recover" | "atomic">
  readonly executor: JhBasicTools.Executor
  readonly runner: JhProcessRunner.Runner
  readonly artifacts: JhArtifact.Store
  readonly fileExists: (relPath: string, cwd: string) => boolean
  readonly cwd: string
  readonly toolNames: ReadonlyArray<string>
  /** Harness-owned execution-environment description injected into every introspection (shell, cwd,
   *  fresh-shell/PATH mechanics) — the model needs to know how `run` commands actually execute. */
  readonly environment?: string
  /** STRICT-mode policy: nudge the top-level task to decompose (a weak model tends to emit one big
   *  atomic write_file with a trivial check — a "false done"). Off by default; the session's Strict
   *  switch turns it on for weak models. */
  readonly forceRootDecompose?: boolean
  /** Filesystem ground truth: the working-directory files WITH their (text) contents. Injected into every
   *  introspection so a step sees the real files and their code — weak models mis-coordinate filenames and
   *  cannot fix a compile error they can't see (the declared-dataflow ids are an unreliable proxy for the
   *  files on disk). A `run` step whose check is `compile` can then re-introspect to a write_file that
   *  fixes the source, and the same compile-check verifies the fix (the write→compile→fix loop). */
  readonly listFiles?: () => ReadonlyArray<{ readonly name: string; readonly content: string }>
  /** STRICT-mode policy (owner #5): after a WEAK mechanical check passes, the model verifies the step's
   *  GOAL was actually achieved against the workspace — a write that passed `artifact_present` did NOT
   *  compile+run+verify. Kills the "false done". Off by default. */
  readonly verifyGoal?: boolean
  /** R1 (jh-improve1): derived-artifact staleness — the harness tracks which run produced each artifact and,
   *  before a run/output_equals check would execute a STALE binary (its sources edited since the build),
   *  auto-re-runs the model's own last successful producing command (kills D1) and caches an unchanged
   *  failing check (kills D10). Requires `listFiles`. Default ON; set false to reproduce pre-R1 behavior. */
  readonly staleness?: boolean
  /** R2 (jh-improve1): cache LLM goal-checks by (goal, workspace, last output) so an unchanged state costs
   *  no LLM call (kills most of D2 — 42–47% of all calls were goal-checks re-confirming a frozen state).
   *  Default ON. */
  readonly goalCheckCache?: boolean
  /** R2 (jh-improve1): at the ROOT whole-task goal-check ONLY, a claim of `achieved:true` must quote VERBATIM
   *  proof from the workspace/last-output or it is treated as not-achieved (kills the run31/32 rubber-stamp).
   *  NOT applied per-step (a weak model can't reliably verbatim-quote its own source, which stalled the run —
   *  baseline run42/43). Default ON. */
  readonly evidence?: boolean
  /** OPTIONAL precise task-completion oracle for root-completion. When the deliverable has an exact,
   *  machine-checkable success criterion (a known expected output), the caller injects it here — it is more
   *  reliable than the LLM goal-check, whose precision is bounded by the model's own knowledge (iter 31:
   *  qwen memorizes Pi to ~50 digits, so it false-done'd a 50-correct output). Given the workspace + last
   *  run stdout, returns whether the task is truly done and, if not, a coarse hint for the fix node. When
   *  absent, root-completion falls back to the LLM goal-check. The program still must COMPUTE the result;
   *  this only CHECKS it (a test oracle, not the model cheating). */
  readonly taskComplete?: (input: { readonly workspace: string; readonly lastOutput: string }) => { readonly done: boolean; readonly detail: string; readonly score?: number }
  /** R3 (jh-improve1): keep the best-scoring workspace snapshot; on escalation + a score regression, restore it
   *  to disk so a rewrite improves on the best attempt instead of discarding it. Needs a graded taskComplete
   *  (score) + listFiles. Default ON. */
  readonly keepBest?: boolean
  /** R4 (jh-improve1): the de-latched cycling escalation ladder (tweak→analyze→targeted_fix→rewrite→cycle),
   *  with a forced instrumented "analyze" stage. Off → the legacy ESCALATE_AFTER latch. Default ON. */
  readonly ladder?: boolean
  /** wave-21 residue: whether the ladder's fix stages use CODE instrumentation (add printf / NAME=value
   *  diagnostics, recompile — the Pi/build path) or a task-agnostic "diagnose, then fix ONLY that part"
   *  directive. Default TRUE (code/numeric tasks). PROSE/writing rigs set FALSE — otherwise the analyze
   *  stage's forced-instrumentation gate HARD-BLOCKS a task with no numeric intermediates (novel run76
   *  relocated onto "no labeled intermediate values" after its self-copy was blocked). When false the
   *  analyze node is not marked instrumented, so the NAME=value demotion gate never fires. */
  readonly forcedAnalyze?: boolean
  /** improve3 P1 (owner #1): after AUTO_REVERT_AFTER consecutive build-DAMAGING edits (an edit_file/write_file
   *  whose compile/rebuild then fails), the harness RESTORES the last verified checkpoint instead of letting the
   *  model keep damaging the file (§I2 hit 4/6 wave-2 runs; the model won't `git_revert` voluntarily). Default
   *  ON, but inert without `revertWorkspace`. */
  readonly autoRevert?: boolean
  /** improve3 P1/L4: the injected revert capability (the engine NEVER shells git). Restores ALL tracked source
   *  files to the last verified checkpoint; the harness implements it over its git plumbing. */
  readonly revertWorkspace?: () => Effect.Effect<{ readonly ok: boolean; readonly detail: string }>
  /** improve3 P3 (owner #3): LAZY shallow decomposition. Attach only a decomposition's TOP level — strip any
   *  nested sub-substeps the model emitted up front (each phase re-plans itself when reached, with full
   *  context). Also: at maxDepth, a node that still wants to decompose runs ATOMICALLY instead of hard-blocking
   *  (I5). Shrinks the fragile root reply (attacks I3 structurally) + defuses the depth-cap. Default ON;
   *  `false` = wave-2 recursive attach + hard depth-block. */
  readonly lazyPlan?: boolean
  /** improve3 P5 (I4): before a check, rebuild only the stale products the check references + their production
   *  chain (not EVERY stale product — a wave-2 500+-rebuild storm). Sub-flag of staleness. Default ON;
   *  `false` = wave-2 rebuild-all-stale. */
  readonly targetedRebuild?: boolean
  /** improve4 P1 (§I6): the persistent REGRESSION SUITE. A leaf's passing run/output_equals check that
   *  executes a workspace product is registered; after any later source edit the digest-stale registered
   *  tests are RE-RUN before the leaf's own check, so a previously-green primitive test broken by the edit
   *  fails immediately and names the changed file (the foundation is LOCKED). Requires `staleness`. Default
   *  ON; `false` = wave-3 behavior exactly. */
  readonly regressionGate?: boolean
  /** improve4 P1/L4: wall-clock budget (ms) for ONE regression-suite trigger — beyond it, remaining stale
   *  tests are skipped and NAMED (never silently partial). Default MAX_SUITE_MS (60s). */
  readonly maxSuiteMs?: number
  /** improve4 P1/L4: monotonic wall-clock source for the suite budget (injected for deterministic tests).
   *  Default `Date.now`. */
  readonly now?: () => number
  /** improve4 P2: gate PHASE progression on a green regression suite. When a compound phase completes (the
   *  bubble chokepoint) — and before the root's oracle/goal-check runs — the digest-stale registered tests
   *  are re-run; if ANY is red the phase does NOT commit, a fix node is grown on it instead (never a
   *  false-phase-complete). Requires `regressionGate`. Default ON; `false` = P1 without the gate. */
  readonly phaseGate?: boolean
  /** improve4 P4: the bounded holistic RE-DERIVE escape. When fix attempts keep failing on the SAME
   *  foundation (the deepest source in the failing check's chain), grow ONE from-scratch re-implementation
   *  of that component (once per file per run) instead of patching symptoms forever — the monolith's
   *  whole-coherence virtue reclaimed at COMPONENT scope. Requires `staleness`. Default ON. */
  readonly rederive?: boolean
  /** improve5 P1a: render workspace files with 1-based `N→` line-number prefixes in the model's EDITING
   *  view (buildContext) so it can address edits by COORDINATE (`replace_lines`) instead of re-quoting a
   *  byte sequence it cannot reproduce (the wave-4 dominant residual: `old_string not found` 16–77×/run).
   *  The goal-check/oracle/evidence paths use the UNNUMBERED render (renderWorkspace) — never number-polluted.
   *  Default ON; `false` = wave-4 unnumbered. */
  readonly numberedWorkspace?: boolean
  /** improve5 P1b: FULL file visibility — raise the per-file render cap 8000 → FILE_RENDER_CAP and, when a
   *  file still exceeds it, show head+tail with an elision that NAMES the omitted line range (never an
   *  unnamed `[truncated]` — run84: pi.c exceeded 8000, the model was asked to quote text it could not see,
   *  AND the render cut poisoned the goal-check into rejecting a complete program as "truncated"). Applies
   *  to BOTH the editing view and the goal-check render. Default ON; `false` = wave-4 8000-char `[truncated]`. */
  readonly fullFiles?: boolean
  /** improve5 P2: TRANSACTIONAL edits — prevent build damage instead of healing it. After a source edit,
   *  if staleness knows a per-file object-compile for the edited file, run it as a SYNTAX gate BEFORE
   *  accepting; a non-compiling edit is REJECTED (the file restored to its pre-image, tool-level undo) with
   *  an actionable message — the workspace never leaves green (run89: auto-revert fired 8× because broken
   *  edits were accepted then had to be healed). Opportunistic (no per-file compile → accept, L4); a rejected
   *  edit is a failed attempt but NOT buildDamage. Requires `staleness`. Default ON. */
  readonly txEdits?: boolean
  /** improve5 P3: DISARM the closure-cardinality force-split trigger under lazyPlan. Since the §5 law-5
   *  amendment the model's context is the DISK workspace, not the declared-artifact closure — so declared
   *  cardinality no longer proxies complexity, and the default threshold (8) sits below the measured c* band
   *  (13–19), MISFIRING (run82: a cardinality-8 force-split at the formula phase hard-blocked a winning run
   *  after the foundation was already locked). With this ON (default, under lazyPlan) the trigger only LOGS
   *  `forced_split_advisory` — no forced decomposition. Note the INVERTED sense: `false` re-arms the wave-4
   *  trigger. */
  readonly noForceSplit?: boolean
  /** improve5 P4: WALL-CLOCK budget awareness. The engine has no time sense (run79/87 spent all 45 min
   *  gold-plating primitives; run84/86 died mid-formula) — so the harness supplies the wall, and at 50%/75%
   *  consumed (one-shot each) the next introspection carries a calm steer to simplify / land an end-to-end
   *  result. `now` is injected (the determinism rule holds). Active only when this dep is present. */
  readonly budget?: { readonly startedAt: number; readonly wallMs: number; readonly now: () => number }
  /** improve5 P4: gate the budget steers (default ON when `budget` is present; `false` = silent). */
  readonly budgetAware?: boolean
  /** improve6 P3: registered tests are NOT infallible — a test whose own file doesn't build, or that stays
   *  red while the program's measured output improves, is marked SUSPECT: it keeps running + reporting but
   *  loses its veto (phase gate + build-damage), and a one-time test-fix node is grown (run101 died 29× on
   *  a t_arctan whose expectation was mathematically impossible). Default ON; `false` = wave-5 behavior. */
  readonly suspectTests?: boolean
  /** improve6 P5: caller-supplied numerics guidance (guard digits / low-precision-first), injected into the
   *  NEXT introspection context ONLY when the numeric-divergence signature fires (score plateau ≥
   *  NUMERIC_SCORE_FLOOR across NUMERIC_PLATEAU samples with a green build) — NEVER into planning prompts
   *  (the wave-5 P6.1 regression: dense guidance in the root prompt derailed plan generation). The engine
   *  knows only the delivery rule; the text is the caller's (L3). */
  readonly numericsHint?: string
  /** improve7 P3 (K4): like `numericsHint`, but the CALLER formats the text from the measured plateau facts
   *  (the graded best score → "correct to ~N digits — raise terms + guard digits"), far sharper than a static
   *  hint (run113 died 2 digits short on the generic text). Preferred over `numericsHint` when both are
   *  present; same delivery rule (numeric-divergence signature only, never a planning prompt). The engine
   *  passes only the score — any task language stays the caller's (L3). */
  readonly numericsHintFor?: (info: { readonly bestScore: number }) => string
  /** improve7 P1 (K5): restore the best-scoring snapshot when the measured score stays BELOW the best for
   *  DROP_RESTORE_AFTER consecutive samples — a plain worsening edit never routes through escalation, so
   *  wave-6's keep-best let run112 walk an 82-digit best down to 17 digits. Needs keepBest + a graded
   *  taskComplete. Default ON. */
  readonly restoreOnDrop?: boolean
  /** improve7 P2 (C7): after COORD_AFTER consecutive `old_string not found` misses on ONE file, edit_file is
   *  DISABLED for that file — the attempt is intercepted pre-execution with a redirect to `replace_lines`
   *  coordinates — until a successful source edit lands on it. The harness stops merely OFFERING coordinates
   *  and enforces them (run111: 23× misses on bigint.c stalled the run at 0.03). Default ON. */
  readonly coordMode?: boolean
  /** improve8 P1 (C9): the timeout for engine-issued command runs — verify checks that set no own timeout,
   *  staleness rebuilds, the tx-gate compile, the regression sweep. On compute tasks a correct program
   *  finishes in seconds, so the 60 s default is pure wall loss per hung run (run57: 30 hung runs × 60 s).
   *  Default DEFAULT_TIMEOUT_MS (60 s); a check's OWN timeoutMs still wins. */
  readonly checkTimeoutMs?: number
  /** improve9 P1a: when a sample scores ≥ NEAR_DONE with the oracle saying NOT done, the oracle's own
   *  `detail` is delivered into the NEXT introspection — the oracle must speak WHEN IT KNOWS (run136
   *  scored 1.0 at event [287]; the D5 "fix the PRINTING" verdict was only ever surfaced at root
   *  completion, which the run never reached — ~370 blind events followed). One-shot per episode,
   *  re-armed when the score leaves the band. Default ON. */
  readonly oracleHint?: boolean
  /** improve10 P1 (§K6): NEVER-GREEN suspicion. An UNREGISTERED product-executing check that fails
   *  with a BYTE-IDENTICAL detail across NEVERGREEN_AFTER distinct source states is oracle-suspect —
   *  same failure × different code means the TEST is the invariant (run138: 28× identical while 85%
   *  of builds hammered one test; run139: an expectation the model had itself disproven). The escape
   *  re-derives the TEST, not the source (improve6's suspicion cannot see these: suspicion requires
   *  registration, registration requires a pass — the registration hole). Default ON. */
  readonly neverGreen?: boolean
  /** improve11 P1 (jh.md §14.2, best-of-N racing): cooperative abort. When it returns true the run
   *  exits via the NORMAL terminal path (reason "aborted") — THROUGH the terminal best-restore — at
   *  the next loop/leaf boundary. Losing racers stop cleanly; their workspaces stay verified-best. */
  readonly aborted?: () => boolean
  readonly limits: { readonly maxDepth: number; readonly maxTotalSteps: number }
  readonly trigger: JhBudget.SplitTrigger
  readonly onLog?: (entry: JhLog.Sequenced) => void
  readonly checkpoint?: (state: State) => Effect.Effect<void>
}

export interface State {
  readonly tree: JhTree.Tree
  readonly artifacts: ReadonlyArray<JhArtifact.Stored>
  readonly log: ReadonlyArray<JhLog.Sequenced>
  readonly telemetry: ReadonlyMap<string, JhBudget.Telemetry>
}

export interface Report {
  readonly status: "done" | "blocked"
  readonly reason?: string
  readonly state: State
}

const stripSubsteps = (d: JhStep.StepDraft): Omit<JhStep.StepDraft, "substeps"> => {
  const { substeps, ...rest } = d
  return rest
}

// improve3 P3b (owner #3): lazy planning — strip nested sub-substeps from a decomposition's TOP level so
// `JhTree.attach` materializes only the immediate phases; each phase re-plans ITSELF when reached (native
// re-introspection with full context). Returns the flattened drafts + how many nested steps were discarded.
const flattenTopLevel = (drafts: ReadonlyArray<JhStep.StepDraft>): { readonly drafts: ReadonlyArray<JhStep.StepDraft>; readonly discarded: number } => {
  const countNested = (d: JhStep.StepDraft): number => (d.substeps ?? []).reduce((n, c) => n + 1 + countNested(c), 0)
  let discarded = 0
  const flat = drafts.map((d) => {
    if (d.substeps && d.substeps.length > 0) {
      discarded += countNested(d)
      return { ...d, substeps: undefined }
    }
    return d
  })
  return { drafts: flat, discarded }
}

// A leaf may retry past its difficulty budget WHILE it is exploring productively — each failure a NOVEL
// error (e.g. an environment problem like a compiler PATH needs several distinct fixes) — up to this hard
// cap. A REPEATED error (a stuck loop) ends it immediately at the budget. (afpro's changing-vs-stuck rule.)
const EXPLORE_CAP = 15
// A leaf is "stuck" only when the SAME error recurs this many times (afpro changing-vs-stuck) — a single
// repeat is not enough; a weak model often needs a few shots at the same mistake before variance breaks it.
const STUCK_REPEATS = 3
// The root soft-decompose retries this many times: a weak model insists atomic on some draws but yields a
// proper plan on others (temperature variance), so a couple of retries reliably gets a decomposition.
const SOFT_DECOMPOSE_ATTEMPTS = 3
// improve3 P1: N consecutive build-DAMAGING edits (an edit whose compile/rebuild then fails) before the harness
// auto-reverts to the last verified checkpoint. 3 = give the model a couple of self-repair shots first, then stop
// the damage (the model won't `git_revert` itself — §I2). Any green build resets the counter.
const AUTO_REVERT_AFTER = 3
// improve4 P1/L4: wall-clock budget for ONE regression-suite trigger. The suite re-runs digest-stale
// REGISTERED tests only (a small set), but each is a compile+run; cap the total so a growing suite never
// eats the 45-min wall — remaining tests are skipped and NAMED (never silently partial).
const MAX_SUITE_MS = 60_000
// improve4 P1: how much of a failing test's output to quote back to the model (its stdout/compile error).
const REGRESSION_TAIL = 1500
// improve4 P4: consecutive fix attempts targeting the SAME foundation file before the harness escalates from
// patch-the-symptom to RE-DERIVE-the-component (a from-scratch re-implementation). 4 = give the ladder's own
// escalation (analyze → targeted_fix → rewrite) a chance first; a foundation still failing after 4 grown
// fixes is the "locked-in subtly-wrong foundation" §I6 names — rewrite it whole, deepest-dependency-first.
const REDERIVE_AFTER = 4
// improve6 P1: after this many CONSECUTIVE gate rejections of the same file within a leaf, the gate YIELDS —
// the next attempt LANDS regardless, restoring iteration-with-visibility. Wave-5 runs 102/104 were locked
// 73-123× behind the gate in one-shot-perfect mode (no landed attempt, no instrumentation, no iteration).
const GATE_YIELD_AFTER = 3
// improve6 P3: a (non-suspect) registered test that has failed this many consecutive rounds while the
// program's measured score did NOT regress is SUSPECT — the source is visibly improving, the test alone
// stays red, so the test is the outlier (tests are code too; run101's impossible t_arctan expectation).
const SUSPECT_AFTER = 4
// improve6 P5: the numeric-divergence signature — some digits provably right (score ≥ floor) but no best-
// score improvement across this many samples, with the build green. Fires the caller's numerics hint.
const NUMERIC_SCORE_FLOOR = 0.05
const NUMERIC_PLATEAU = 3
// improve7 P1 (K5): consecutive below-best score samples before the harness restores the best snapshot mid-
// run — 2, because ONE bad sample can be the model mid-repair (an intentionally reduced-scope test run); two
// in a row is a real regression walk. Gated on the best being WORTH restoring (RESTORE_FLOOR): restoring a
// 0.03 state is churn, not rescue.
const DROP_RESTORE_AFTER = 2
const RESTORE_FLOOR = 0.1
// improve7 P2 (C7): consecutive edit_file `old_string not found` misses on ONE file before coordinates
// become mandatory for it. 3 = the near-miss tiers get a fair shot first; a model that mis-quotes a file 3×
// in a row will not start reproducing its bytes on the 4th (run111: 23×; run115: 12×).
const COORD_AFTER = 3
// improve9 P1a: the score band in which the oracle's not-done verdict is decisive enough to interrupt
// with — every digit measured correct yet not done = a formatting/placement defect (the D5 class).
const NEAR_DONE = 0.999
// improve10 P1 (§K6): identical failures across this many DISTINCT source states before an unregistered
// test is oracle-suspect. 3 = three different implementations all "failing" the same way is the test.
const NEVERGREEN_AFTER = 3
// improve10 P2: lifetime per-file edit_file misses before the coordinate lock goes STICKY — run140's 17
// misses never tripped the consecutive counter (interleaved successes reset it by design).
const COORD_CUMULATIVE = 6
// improve5 P1b: the per-file render cap. Raised 8000 → 24000 so a whole bignum/formula source is VISIBLE
// (run84: pi.c > 8000 → the model was asked to quote invisible text, 73 misses). A 24000-char file ≈ 6–7K
// tokens; a ~5-file workspace fits qwen's 64K with headroom (P0-measured). Over the cap → head+tail with a
// NAMED elision (the omitted line range), never an unnamed `[truncated]`.
const FILE_RENDER_CAP = 24_000
const WAVE4_FILE_CAP = 8_000 // improve5 P1b flags-off: the exact wave-4 cap + unnamed truncation (ablation)

// improve5 P1a/b: render ONE workspace file for a prompt. `numbered` prefixes each line `N→` (1-based) so
// the model can address edits by coordinate (replace_lines). `fullFiles` picks the cap + elision style: ON
// = 24000 + a head/tail split whose elision NAMES the omitted lines; OFF = the wave-4 8000 char-cap + a bare
// `[truncated]`. Pure + total.
function renderFileBlock(name: string, content: string, opts: { readonly numbered: boolean; readonly fullFiles: boolean }): string {
  const numberize = (text: string): string => (opts.numbered ? text.split("\n").map((l, i) => `${i + 1}→${l}`).join("\n") : text)
  let body: string
  if (!opts.fullFiles) {
    // wave-4 exact: raw char-cap + unnamed truncation (numbered line-wise on the shown part only).
    body = numberize(content.length > WAVE4_FILE_CAP ? content.slice(0, WAVE4_FILE_CAP) + "\n…[truncated]…" : content)
  } else if (content.length <= FILE_RENDER_CAP) {
    body = numberize(content)
  } else {
    // full-visibility over-cap: head + tail with a NAMED elision so the model KNOWS what it cannot see.
    const lines = content.split("\n")
    const headBudget = Math.floor(FILE_RENDER_CAP * 0.6)
    const tailBudget = FILE_RENDER_CAP - headBudget
    let hc = 0
    let headEnd = 0
    while (headEnd < lines.length && hc + lines[headEnd]!.length + 1 <= headBudget) {
      hc += lines[headEnd]!.length + 1
      headEnd++
    }
    let tc = 0
    let tailStart = lines.length
    while (tailStart > headEnd + 1 && tc + lines[tailStart - 1]!.length + 1 <= tailBudget) {
      tc += lines[tailStart - 1]!.length + 1
      tailStart--
    }
    const num = (text: string, idx: number): string => (opts.numbered ? `${idx + 1}→${text}` : text)
    const head = lines.slice(0, headEnd).map((l, i) => num(l, i))
    const tail = lines.slice(tailStart).map((l, i) => num(l, tailStart + i))
    const elision = `…lines ${headEnd + 1}-${tailStart} omitted (${tailStart - headEnd} lines; use read_file "${name}" to see them)…`
    body = [...head, elision, ...tail].join("\n")
  }
  return `### ${name}\n\`\`\`\n${body}\n\`\`\``
}
// improve3 P2a (owner #2): the ROOT plan is the single most critical introspection — a malformed root reply
// killed a whole run in ~2 min (run63/§I3). Give the root MANY more parse-retries (with the P2b located hint
// each time); a non-root leaf keeps its 2 attempts (a failed leaf has never-dead-end, a failed root doesn't).
const ROOT_INTROSPECT_ATTEMPTS = 10
const errorSig = (detail: string): string => detail.slice(0, 160).trim()
// A leaf's check is its GOAL gate. The recovery loop may CORRECT a check's command (pi.exe→.\pi.exe —
// adopt it), but must NEVER DOWNGRADE it: when the model does an intermediate write_file to fix a bug, its
// weak (artifact_present) check must not replace the leaf's `run`/`output_equals` correctness gate — else
// a stale binary false-passes (iter 20). Rank checks by how much they prove; adopt a recovery check only
// if it is at least as strong as the current one.
const checkRank = (c: JhStep.Check): number =>
  c.type === "output_equals" ? 4 : c.type === "run" ? 3 : c.type === "compile" ? 2 : c.type === "file_exists" ? 1 : 0
// A grown fix node's goal. After several failed fixes of the SAME problem (priorAttempts high), a weak model
// is in a local rut (iter 30: it printed ~2.95 ~40× while only tweaking trailing digits) — ESCALATE from
// "tweak the source" to "rewrite from scratch + add debug prints", which pushes it out of the rut.
const ESCALATE_AFTER = 4
const fixNodeGoal = (baseGoal: string, detail: string, priorAttempts: number): string =>
  priorAttempts >= ESCALATE_AFTER
    ? `Several attempts at "${baseGoal}" have FAILED with the SAME wrong result — ${detail}. STOP tweaking the current code: REWRITE the computation from scratch with a cleaner, DIFFERENT approach, re-derive the math carefully step by step, and ADD printf statements to print each intermediate value so you can see EXACTLY where it diverges from what you expect — then recompile and re-run.`
    : `The previous attempt at "${baseGoal}" did not pass its check — ${detail}. Do the next single action to fix it: if the program's OUTPUT is WRONG or it crashed, EDIT the source code to fix the bug, RECOMPILE, then re-run and verify — do NOT just re-run the same binary.`
// R4 escalation-ladder directive for a grown fix node, selected by the ladder stage. Note `detail` is the
// FULL bounded verify detail (D7 — not the 160-char errorSig), so the fix node sees the real error.
const stageFixGoal = (stage: JhLadder.Stage, baseGoal: string, detail: string, instrument = true): { readonly goal: string; readonly analyze: boolean } => {
  if (!instrument) {
    // Task-agnostic escalation (no compile, no numeric intermediates — prose/writing/config tasks). Same
    // ladder SHAPE (diagnose before you redo → change only the offending part → last-resort rewrite) with
    // NO code vocabulary and NO forced NAME=value instrumentation (analyze:false ⇒ the demotion gate at the
    // leaf loop never applies). The generic "which part / why, quoting the offending element" is the prose
    // twin of "which function the printed values prove wrong".
    switch (stage) {
      case "analyze":
        return {
          goal: `The attempts at "${baseGoal}" keep failing — ${detail}. Do NOT redo the whole thing yet. First DIAGNOSE: name precisely which part of your work the check is rejecting and WHY, quoting the exact offending element, before you change anything.`,
          analyze: false,
        }
      case "targeted_fix":
        return {
          goal: `Using that diagnosis, change ONLY the specific part the check rejected — leave everything else exactly as it is — then re-verify.`,
          analyze: false,
        }
      case "rewrite":
        return {
          goal: `Several attempts at "${baseGoal}" have FAILED the same way — ${detail}. Stop patching: redo THIS piece from scratch with a genuinely DIFFERENT approach that avoids the repeated failure, then re-verify.`,
          analyze: false,
        }
      default: // tweak
        return {
          goal: `The previous attempt at "${baseGoal}" did not pass its check — ${detail}. Make the smallest change that addresses exactly what the check reported, then re-verify.`,
          analyze: false,
        }
    }
  }
  switch (stage) {
    case "analyze":
      return {
        goal: `The attempts at "${baseGoal}" keep failing — ${detail}. Do NOT rewrite yet. INSTRUMENT the program: add labeled debug prints so each key intermediate quantity prints on its OWN line as NAME=value (at least 3 distinct values on the code path that produces the wrong result), recompile, and run. The OUTPUT of this step is those diagnostic NAME=value lines.`,
        analyze: true,
      }
    case "targeted_fix":
      return {
        goal: `Diagnostic NAME=value output from the last run is shown in the context above. State which SINGLE function or computation the printed values prove to be wrong, and fix ONLY that — do not rewrite anything else. Then recompile and re-run.`,
        analyze: false,
      }
    case "rewrite":
      return {
        goal: `Several attempts at "${baseGoal}" have FAILED with the SAME wrong result — ${detail}. STOP tweaking the current code: REWRITE the computation from scratch with a cleaner, DIFFERENT approach, re-derive the math step by step, and ADD printf statements to print each intermediate value — then recompile and re-run.`,
        analyze: false,
      }
    default: // tweak
      return {
        goal: `The previous attempt at "${baseGoal}" did not pass its check — ${detail}. Do the next single action to fix it: if the program's OUTPUT is WRONG or it crashed, EDIT the source to fix the bug, RECOMPILE, then re-run and verify — do NOT just re-run the same binary.`,
        analyze: false,
      }
  }
}
// improve4 P5 (runs 69/76): an OPAQUE CRASH — a non-zero exit with NO output — gives the model nothing to
// tweak, yet the ladder spends its tweak rounds blind. Detect the class: an empty failing detail (a check
// that exited non-zero with no stdout) or the executor's runtime-CRASH narration. Such a failure routes
// straight to the ANALYZE stage (an instrumented run is the only move that can produce information).
const isOpaqueCrash = (detail: string): boolean => {
  const d = detail.trim()
  return d === "" || d.includes("runtime CRASH")
}
// A leaf's output counts as "instrumented" when it prints ≥3 labeled NAME=value lines (mechanical shape
// check — never content; forces run-30's missing diagnosis).
const NAME_VALUE = /^\s*[A-Za-z_][\w.[\]]* *= *-?[\d.]/gm
const hasInstrumentation = (output: string): boolean => (output.match(NAME_VALUE) ?? []).length >= 3

export function runTask(deps: Deps, task: { readonly goal: string }, resume?: State): Effect.Effect<Report> {
  const { maxDepth, maxTotalSteps } = deps.limits

  // ---- mutable engine state (closed over by every helper below) ----
  let tree: JhTree.Tree = resume?.tree ?? JhTree.create({ goal: task.goal, size: "atomic", success: "the task is complete" })
  const telemetry = new Map<string, JhBudget.Telemetry>(resume?.telemetry ?? [])
  const logArr: JhLog.Sequenced[] = [...(resume?.log ?? [])]
  let seq = logArr.length
  let lastBlockReason: string | undefined
  // The most recent `run` action's stdout — a program prints its RESULT to stdout, not to a file, so the
  // goal-checks (which otherwise only see workspace FILES) need it to judge whether a computed RESULT is
  // actually correct (iter 22: a program that ran and printed wrong digits false-passed a file-only check).
  let lastRunOutput = ""
  // R1: engine-run-scoped derived-artifact tracker (a minimal build graph). Active only when the caller
  // supplies `listFiles` (the workspace ground truth it needs) and hasn't opted out. Products persist
  // across leaves — a compile in one leaf, a check in another (jh-improve1 L4: in-memory, not in State).
  const staleness = deps.staleness !== false && deps.listFiles ? JhStaleness.tracker() : undefined
  const snapFiles = (): ReadonlyArray<JhStaleness.FileSnap> => (staleness ? staleness.snap(deps.listFiles!()) : [])
  const baseName = (s: string): string => s.replace(/^\.[/\\]/, "").split(/[/\\]/).pop() ?? s // improve5 P2: match a tool path to a listFiles entry
  // improve4 P1 (§I6): the persistent regression registry — active only WITH staleness (it feeds off the
  // tracker's source digests). Registers the model's own passing product-executing checks and re-runs the
  // digest-stale ones after later edits. Engine-run-scoped, in-memory (L4).
  const regression = deps.regressionGate !== false && staleness ? JhRegression.registry() : undefined
  const now = deps.now ?? (() => Date.now())
  const checkTimeout = deps.checkTimeoutMs ?? JhVerifier.DEFAULT_TIMEOUT_MS // improve8 P1 (C9)
  const phaseGateOn = deps.phaseGate !== false && regression !== undefined // improve4 P2 (requires regressionGate)
  const txEditsOn = deps.txEdits !== false && staleness !== undefined // improve5 P2 (needs the per-file compile registry)
  const SOURCE_EDIT_TOOLS = new Set(["write_file", "edit_file", "replace_lines"])
  // R3 keep-best + R4 ladder state (engine-run-scoped, in-memory — jh-improve1 L4).
  let bestScore = Number.NEGATIVE_INFINITY
  let bestSnapshot: ReadonlyArray<{ readonly name: string; readonly content: string }> | undefined
  // improve6 P2: keep-best tiebreak — at an EQUAL score, a state with more registered tests passing is
  // better (the suite green-count is a second gradient the safety layer must read, not ignore).
  let bestSuiteGreen = -1
  let lastSweepGreen = 0
  // improve6 P5: numeric-divergence tracking — samples since the best score last improved; the hint is
  // one-shot per plateau (re-armed by any improvement).
  let scoreStagnant = 0
  let numericsArmed = true
  let pendingNumericsHint: string | undefined
  // improve7 P1 (K5): consecutive below-best samples (reset by any sample at-or-above best). The sampler is
  // sync, so it only ARMS the restore; the call site performs it (Effect land).
  let dropStreak = 0
  let pendingDropRestore = false
  // improve9 P1a/P1b: the near-done oracle directive (one-shot per episode) + the oracle-done flag the
  // main loop short-circuits on (re-checked against the oracle before committing — never on the sample alone).
  let pendingOracleHint: string | undefined
  let oracleHintArmed = true
  let oracleDone = false
  // improve9 P2: the workspace text-file contents at the most recent PASSING verification — a
  // best-snapshot file whose on-disk content matches NEITHER the best snapshot NOR this capture is
  // trailing UNVERIFIED drift, and loses to the verified best at finalize. A verified-green tail
  // (its state captured here) is never overwritten.
  let lastGreenFiles: ReadonlyMap<string, string> | undefined
  // improve7 P2 (C7): per-file consecutive edit_file mis-quotes + the files locked to coordinate edits.
  const editMisses = new Map<string, number>()
  const coordLocked = new Set<string>()
  // improve10 P2: LIFETIME per-file misses — past COORD_CUMULATIVE the lock is sticky (interleaved
  // successful edits reset the consecutive counter but not this one; run140: 17 misses, 0 locks).
  const editMissesTotal = new Map<string, number>()
  // improve10 P1 (§K6): never-green tracking — per normalized command, the identical failure detail and
  // how many DISTINCT source states produced it; one test-fix growth per command.
  const neverGreenFails = new Map<string, { detail: string; count: number; lastDigest: string }>()
  const neverGreenGrown = new Set<string>()
  // improve6 P3: suspect-test bookkeeping — the score when a test FIRST went red (the non-regression guard),
  // and the tests whose one-time fix node was already grown.
  const scoreAtFirstFail = new Map<string, number>()
  const testFixGrown = new Set<string>()
  // improve6 P1: consecutive gate rejections per file — ENGINE-scoped, not per-leaf: wave-5's 73-123
  // rejections spanned GROWN FIX SIBLINGS (each a fresh leaf), so a per-leaf counter would reset before
  // ever yielding. Reset by a clean gate compile or by the yield itself.
  const gateRejects = new Map<string, number>()
  const ladders = new Map<string, JhLadder.LadderState>() // parentID → escalation state
  const lastFixBest = new Map<string, number>() // parentID → bestScore at its last grown fix node (for scoreImproved)
  const analyzeNodes = new Set<string>() // nodeIds the harness forced to be instrumented "analyze" steps
  // improve4 P4: re-derive bookkeeping (engine-run-scoped, L4). `rederivePressure` = consecutive fix attempts
  // per FOUNDATION file (the deepest source in the failing chain); at REDERIVE_AFTER the harness grows a
  // from-scratch re-implementation of that file. `rederived` = files already re-derived (once per run).
  const rederivePressure = new Map<string, number>()
  const rederived = new Set<string>()
  // improve3 P1: consecutive build-DAMAGING edits (reset on any green build); when it hits AUTO_REVERT_AFTER the
  // harness restores the last verified checkpoint. `autoRevertOn` disables itself if a revert ever fails (never
  // loop on a broken revert). `pendingRevertMessage` is delivered to the very next introspection.
  let buildDamage = 0
  let autoRevertOn = deps.autoRevert !== false && !!deps.revertWorkspace
  let pendingRevertMessage: string | undefined
  const firedBudget = new Set<number>() // improve5 P4: wall-clock thresholds already steered (one-shot each)

  const emit = (entry: JhLog.Entry): void => {
    const seqd = { ...entry, seq: seq++ } as JhLog.Sequenced
    logArr.push(seqd)
    deps.onLog?.(seqd)
  }
  const telemetryOf = (id: string): JhBudget.Telemetry => telemetry.get(id) ?? JhBudget.emptyTelemetry
  const updateTelemetry = (id: string, fn: (t: JhBudget.Telemetry) => JhBudget.Telemetry): void => {
    telemetry.set(id, fn(telemetryOf(id)))
  }
  const snapshot = (): State => ({ tree, artifacts: deps.artifacts.snapshot(), log: [...logArr], telemetry: new Map(telemetry) })
  const report = (status: "done" | "blocked", reason?: string): Report => ({ status, reason, state: snapshot() })
  const checkpoint = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (deps.checkpoint) yield* deps.checkpoint(snapshot())
    })

  const contentFor = (id: string): string => {
    const s = deps.artifacts.get(id)
    return s ? s.content : "<artifact not yet produced>"
  }
  // The root IS the task — introspection must NOT be allowed to narrow it (a weak model reframes "write
  // AND compile AND verify X" down to "write X", losing requirements). Always introspect the root against
  // the original task goal.
  const goalOf = (nodeId: JhStep.StepID): string => (nodeId === tree.root ? task.goal : JhTree.get(tree, nodeId)!.draft.goal)
  const buildContext = (nodeId: JhStep.StepID, extra?: string): string => {
    const cur = JhTree.get(tree, nodeId)!
    const closureIds = JhDataflow.closure(tree, nodeId)
    const directRefs = cur.draft.consumes ?? []
    const directIds = new Set(directRefs.map((r) => r.id))
    const direct = directRefs.map((r) => ({ id: r.id, type: r.type, content: contentFor(r.id) }))
    const transitive = [...closureIds]
      .filter((id) => !directIds.has(id))
      .map((id) => {
        const s = deps.artifacts.get(id)
        return { id, type: (s?.type ?? "text") as JhStep.ArtifactType, content: s ? s.content : "<artifact not yet produced>" }
      })
    const ancestorGoals = JhTree.ancestors(tree, nodeId).map((n) => n.draft.goal)
    const base = JhContext.assemble({ taskGoal: task.goal, ancestorGoals, stepGoal: goalOf(nodeId), direct, transitive })
    let fileBlock = ""
    if (deps.listFiles) {
      const files = deps.listFiles()
      if (files.length === 0) fileBlock = "\n\n# Working directory\n(no files yet)"
      else {
        // improve5 P1a/b: the model's EDITING view — numbered (so it can `replace_lines` by coordinate) + full-visibility.
        const numbered = deps.numberedWorkspace !== false
        const bodies = files.map((f) => renderFileBlock(f.name, f.content, { numbered, fullFiles: deps.fullFiles !== false }))
        const numNote = numbered ? " — each line is prefixed `N→` (the 1-based line number, for `replace_lines`)" : ""
        fileBlock = `\n\n# Working directory (the ACTUAL files on disk${numNote}; reference these exact names, and fix code here if a step failed)\n${bodies.join("\n\n")}`
      }
    }
    // D7 (jh-improve1): grown fix/analyze nodes must SEE the program's most recent stdout (the diagnostics) —
    // otherwise a step told to "fix what the values show" is acting blind (the 160-char cross-node collapse).
    const outputBlock = lastRunOutput ? `\n\n# Most recent program output (stdout, tail)\n\`\`\`\n${lastRunOutput.length > 2000 ? lastRunOutput.slice(-2000) : lastRunOutput}\n\`\`\`` : ""
    // improve3 P1: after an auto-revert, deliver the restore notice to the NEXT introspection, then clear it
    // (consume-once). The workspace listing above already reflects the restored files.
    const revertBlock = pendingRevertMessage ? `\n\n# ⚠️ Workspace restored by the harness\n${pendingRevertMessage}` : ""
    pendingRevertMessage = undefined
    // improve5 P4: wall-clock budget steer — at 50%/75% consumed (one-shot each) inject a calm "simplify /
    // land an end-to-end result" nudge (the engine otherwise has no time sense; run79/87 gold-plated to the wall).
    let budgetBlock = ""
    if (deps.budgetAware !== false && deps.budget && deps.budget.wallMs > 0) {
      const frac = (deps.budget.now() - deps.budget.startedAt) / deps.budget.wallMs
      for (const th of [0.5, 0.75]) {
        if (frac >= th && !firedBudget.has(th)) {
          firedBudget.add(th)
          emit({ type: "budget_note", step: nodeId, fraction: th })
          budgetBlock =
            th >= 0.75
              ? "\n\n# ⏱ ~a quarter of the time budget remains\nGet an END-TO-END result NOW, even at REDUCED scope/precision (e.g. compute fewer digits first): a complete working pipeline you can VERIFY beats a perfect half. Finish it, verify, then improve only if time remains."
              : "\n\n# ⏱ ~half the time budget remains\nPrefer the SIMPLEST implementation that passes the tests; do NOT gold-plate individual components — an end-to-end working result matters far more than a perfect part."
        }
      }
    }
    // improve6 P5: consume-once numerics hint — delivered to the working context (recovery/fix), never a
    // planning prompt (this builder feeds introspections mid-work; the signature only arms mid-leaf).
    const numericsBlock = pendingNumericsHint ? `\n\n# Numerical-computation guidance (the output has stopped improving)\n${pendingNumericsHint}` : ""
    pendingNumericsHint = undefined
    // improve9 P1a: consume-once near-done oracle directive — the caller's own verdict, verbatim (L1).
    const oracleBlock = pendingOracleHint
      ? `\n\n# ⚡ THE TASK ORACLE: the task is ONE SMALL FIX from complete\n${pendingOracleHint}\nDo EXACTLY this now — do not edit or build ANYTHING else first.`
      : ""
    pendingOracleHint = undefined
    const full = `${base}${fileBlock}${outputBlock}${revertBlock}${budgetBlock}${numericsBlock}${oracleBlock}`
    return extra ? `${full}\n\n${extra}` : full
  }
  /** the current workspace (file names + contents) as a plain block — for the goal-achievement check + the
   *  precise oracle + the evidence substring check. UNNUMBERED (improve5 P1a: numbering only the EDITING view;
   *  the oracle extracts digits and the evidence check matches raw quotes, so numbers must NOT pollute this
   *  render), but WITH full visibility (P1b: the raised cap + named elision — so the goal-check can't mistake
   *  a render cut for an incomplete program, the run84 harm). */
  const renderWorkspace = (): string => {
    const files = deps.listFiles?.() ?? []
    if (files.length === 0) return "(no files yet)"
    return files.map((f) => renderFileBlock(f.name, f.content, { numbered: false, fullFiles: deps.fullFiles !== false })).join("\n\n")
  }
  // R3: the current graded progress score (from the caller's oracle), or undefined if ungraded.
  const currentScore = (): number | undefined => deps.taskComplete?.({ workspace: renderWorkspace(), lastOutput: lastRunOutput }).score
  // R3: sample the score after a successful run; on a new best, snapshot the TEXT files (keep-best).
  // improve6 P2: an EQUAL score with MORE registered tests passing is also a new best (the suite green-count
  // tiebreak — the safety layer reads both gradients). improve6 P5: no improvement across NUMERIC_PLATEAU
  // samples while some digits are provably right (score ≥ floor) = the numeric-divergence signature → arm
  // the caller's numerics hint for the NEXT introspection context (one-shot per plateau).
  const sampleScore = (nodeId: JhStep.StepID): void => {
    const verdict = deps.taskComplete?.({ workspace: renderWorkspace(), lastOutput: lastRunOutput })
    const s = verdict?.score
    // improve9 P1a/P1b: the oracle speaks WHEN IT KNOWS. done=true arms the main-loop short-circuit
    // (re-checked there — never committed on the sample alone). A near-done NOT-done verdict (the D5
    // class: every digit measured correct, only formatting wrong) is delivered to the NEXT
    // introspection — run136 held that verdict for ~370 events without the model ever seeing it.
    if (verdict !== undefined) {
      if (verdict.done) oracleDone = true
      const near = s !== undefined && s >= NEAR_DONE && !verdict.done
      if (near && deps.oracleHint !== false && oracleHintArmed && verdict.detail) {
        oracleHintArmed = false
        pendingOracleHint = verdict.detail
        emit({ type: "oracle_hint", step: nodeId })
      }
      if (!near) oracleHintArmed = true
    }
    if (s === undefined) return
    const improved = s > bestScore
    const greenTiebreak = s === bestScore && lastSweepGreen > bestSuiteGreen
    if (improved || greenTiebreak) {
      bestScore = s
      bestSuiteGreen = lastSweepGreen
      dropStreak = 0 // improve7 P1: at-or-above best is not a drop
      if (improved) {
        scoreStagnant = 0
        numericsArmed = true
        emit({ type: "scored", step: nodeId, score: s })
      }
      if (deps.keepBest !== false && deps.listFiles) {
        bestSnapshot = deps.listFiles().filter((f) => !f.content.startsWith("<compiled binary")).map((f) => ({ name: f.name, content: f.content }))
      }
      return
    }
    scoreStagnant++
    // improve7 P1 (K5): a sample strictly BELOW the best is a regression walk — after DROP_RESTORE_AFTER
    // consecutive ones (and a best worth restoring) arm the restore; the call site performs it.
    if (deps.restoreOnDrop !== false && deps.keepBest !== false && s < bestScore && bestScore >= RESTORE_FLOOR) {
      dropStreak++
      if (dropStreak >= DROP_RESTORE_AFTER) {
        dropStreak = 0
        pendingDropRestore = true
      }
    } else {
      dropStreak = 0
    }
    // improve7 P3 (K4): the caller-formatted precise directive (bestScore → "~N digits") is preferred over
    // the static text; delivery mechanics unchanged (plateau signature, one-shot, working context only).
    const hintText = deps.numericsHintFor ? deps.numericsHintFor({ bestScore }) : deps.numericsHint
    if (hintText && numericsArmed && bestScore >= NUMERIC_SCORE_FLOOR && scoreStagnant >= NUMERIC_PLATEAU) {
      numericsArmed = false
      pendingNumericsHint = hintText
      emit({ type: "numerics_hint", step: nodeId })
    }
  }
  // R3: on escalation + a score REGRESSION below the best, restore the best-scoring source snapshot to disk so
  // a fix builds on the best attempt (products auto-rebuild via P1). No-op if keepBest off or nothing to restore.
  const restoreBest = (nodeId: JhStep.StepID, reason: "escalation" | "drop" | "final" = "escalation"): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (deps.keepBest === false || !bestSnapshot) return false
      const cur = currentScore()
      if (cur !== undefined && cur >= bestScore) return false // not a regression
      const beforeRestore = snapFiles()
      for (const f of bestSnapshot) yield* deps.executor.run({ tool: "write_file", args: { path: f.name, content: f.content }, produces: [], cwd: deps.cwd })
      // Re-sync staleness (the auto-revert precedent): the restore changed sources outside a model action, so
      // record it — the next check auto-rebuilds the now-stale products through the normal path.
      if (staleness) staleness.recordAction({ tool: "write_file", ok: true, before: beforeRestore, after: snapFiles() })
      emit({ type: "restored_best", step: nodeId, score: bestScore, reason })
      return true
    })
  // improve7 P1 (K5): every terminal path delivers the BEST state — a run must never END on a workspace that
  // scores below its own best (run112 walked away from 82 digits, run113 from 98; wave-6's keep-best only
  // restored via escalation). `restoreBest` no-ops unless the current state is a genuine regression, so a
  // clean `done` (current == best) is untouched.
  const finalizeReport = (status: "done" | "blocked", reason?: string): Effect.Effect<Report> =>
    Effect.gen(function* () {
      // improve9 P2: trailing UNVERIFIED edits lose to the last VERIFIED state. A best-snapshot file
      // whose on-disk content matches NEITHER the best snapshot NOR the last verified-green capture is
      // unverified surgery (run136's tail — invisible to the score because no successful run
      // re-sampled it); restore the proven snapshot. A verified-green tail is never overwritten (L2).
      if (status !== "done" && deps.keepBest !== false && bestSnapshot && deps.listFiles) {
        const onDisk = new Map(deps.listFiles().map((f) => [f.name, f.content]))
        const drifted = bestSnapshot.some((f) => {
          const cur = onDisk.get(f.name)
          return cur !== f.content && cur !== lastGreenFiles?.get(f.name)
        })
        const cur = currentScore()
        if (drifted && (cur === undefined || cur >= bestScore)) {
          const beforeRestore = snapFiles()
          for (const f of bestSnapshot) yield* deps.executor.run({ tool: "write_file", args: { path: f.name, content: f.content }, produces: [], cwd: deps.cwd })
          if (staleness) staleness.recordAction({ tool: "write_file", ok: true, before: beforeRestore, after: snapFiles() })
          emit({ type: "restored_best", step: tree.root, score: bestScore, reason: "final" })
        }
      }
      yield* restoreBest(tree.root, "final")
      return report(status, reason)
    })
  // R3+R4: grow a fix node on `parentID` — pick the escalation stage (ladder or legacy latch), restore the
  // best snapshot on an escalated regression, mark a forced-analyze node, and append it. Shared by the leaf-
  // stuck and root-extend sites.
  const growFixNode = (parentID: JhStep.StepID, baseGoal: string, fullDetail: string, defaultSuccess: string, failingCommand?: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      // improve4 P4: the bounded holistic RE-DERIVE escape. If this fix targets a foundation (the deepest
      // source in the failing check's chain) that keeps failing across REDERIVE_AFTER fix attempts, stop
      // patching symptoms — grow ONE from-scratch re-implementation of that COMPONENT (once per file per run,
      // deepest-dependency-first: the library everything links, not the most-edited file — run75's most-edited
      // was the wrong one). Supersedes the normal stage fix for this growth.
      if (deps.rederive !== false && staleness && failingCommand) {
        const target = staleness.deepestSource(failingCommand, snapFiles())
        if (target && !rederived.has(target)) {
          const n = (rederivePressure.get(target) ?? 0) + 1
          rederivePressure.set(target, n)
          if (n >= REDERIVE_AFTER) {
            rederived.add(target)
            const rdGoal = `Component ${target} keeps FAILING its test after ${n} repeated fix attempts — patching it is not working. Write a COMPLETELY FRESH implementation of ${target} from first principles: do NOT read or patch the old code (it will be REPLACED), keep the SAME function signatures so everything that links against it still builds, and make it pass \`${failingCommand}\` AND the boundary cases (the largest operands your representation allows, a carry/borrow across the limb/digit boundary, and the zero/identity cases). Then the whole test suite re-runs.`
            const rdDraft: JhStep.StepDraft = { goal: rdGoal, size: "atomic", success: `${target} is re-implemented from scratch and its test passes` }
            const appended = JhTree.appendChild(tree, parentID, rdDraft, maxDepth)
            if (!(appended instanceof JhTree.AttachError)) {
              tree = appended
              emit({ type: "rederived", step: parentID, file: target })
              emit({ type: "expanded", step: parentID, children: JhTree.get(tree, parentID)!.children.length })
              return
            }
            rederived.delete(target) // couldn't grow (depth/budget) — undo the mark; fall through to a normal fix
          }
        }
      }
      const sig = errorSig(fullDetail)
      const prevBest = lastFixBest.get(parentID) ?? Number.NEGATIVE_INFINITY
      const scoreImproved = bestScore > prevBest
      lastFixBest.set(parentID, bestScore)
      const childCount = JhTree.get(tree, parentID)!.children.length
      let stage: JhLadder.Stage
      if (deps.ladder !== false) {
        const state = JhLadder.next(ladders.get(parentID), { sig, scoreImproved })
        ladders.set(parentID, state)
        stage = state.stage
        // improve4 P5: an opaque crash at the blind (tweak) stage jumps straight to analyze — instrument, don't
        // tweak in the dark. (An analyze run yields NAME=value output, so the next failure is no longer opaque.)
        if (stage === "tweak" && isOpaqueCrash(fullDetail)) stage = "analyze"
      } else {
        stage = childCount >= ESCALATE_AFTER ? "rewrite" : "tweak" // legacy latch
      }
      const restored = stage !== "tweak" ? yield* restoreBest(parentID) : false
      const fix = deps.ladder !== false ? stageFixGoal(stage, baseGoal, fullDetail, deps.forcedAnalyze !== false) : { goal: fixNodeGoal(baseGoal, sig, childCount), analyze: false }
      const goal = restored ? `The best attempt so far (progress score ${bestScore.toFixed(3)}) has been RESTORED to the working directory — improve on IT; do not start over. ${fix.goal}` : fix.goal
      const fixDraft: JhStep.StepDraft = { goal, size: "atomic", success: defaultSuccess, kind: fix.analyze ? "analyze" : undefined }
      const appended = JhTree.appendChild(tree, parentID, fixDraft, maxDepth)
      if (!(appended instanceof JhTree.AttachError)) {
        tree = appended
        const newId = JhTree.get(tree, parentID)!.children.at(-1)
        if (fix.analyze && newId !== undefined) analyzeNodes.add(newId)
        emit({ type: "expanded", step: parentID, children: JhTree.get(tree, parentID)!.children.length })
      }
    })
  // D11 (char run45/47): a NON-root node whose introspection is unusable (unparseable / malformed /
  // dataflow-broken — the LLM is up but emitted garbage) must NOT hard-block and cascade to the root (that
  // discarded an 85-digit near-miss). Best-effort-commit it and grow a fix sibling — the never-dead-end
  // principle applied to STRUCTURAL failures, not just stuck checks. Root / no-parent / budget → blockNode.
  const structuralFailRecover = (node: JhTree.Node, reason: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const parentID = JhTree.get(tree, node.id)?.parent
      if (deps.verifyGoal && parentID !== undefined && JhTree.size(tree) < maxTotalSteps) {
        tree = JhTree.setStatus(tree, node.id, "committed")
        emit({ type: "committed_best_effort", step: node.id, reason })
        yield* growFixNode(parentID, JhTree.get(tree, node.id)!.draft.goal, `the previous step could not be completed (${reason} — the model emitted an unusable reply); do the step's work now with a clean, well-formed single action`, "the step's goal is met")
        yield* bubble(node.id)
      } else if (parentID === undefined && (deps.forceRootDecompose || deps.verifyGoal || deps.taskComplete)) {
        // improve5 root-hardening (E7): the ROOT could not be planned (a malformed multi-step reply). Do NOT
        // hard-block a capable model (run92-95 died at the root in 10s on a JSON fumble — the exact harness
        // harm this wave removes). DEGRADE to a single ATOMIC start step (a far simpler introspect than a whole
        // plan); the exploration loop + the root-completion oracle drive the rest. If even one atomic step
        // won't parse, block as the last resort.
        const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { allowDecomposition: false, formatReminder: 'Emit exactly ONE atomic Step — a single tool call for the FIRST concrete action toward the task (NOT a multi-step plan). Fill: goal, size:"atomic", tool, args, check.' })))
        if (Exit.isSuccess(ex)) {
          const parsed = JhExpander.parseReply(ex.value, { fallbackGoal: goalOf(node.id) })
          if (parsed.ok && parsed.draft.size === "atomic" && JhStep.structuralIssues(parsed.draft).filter((i) => i.severity === "error").length === 0) {
            tree = JhTree.fill(tree, node.id, stripSubsteps(parsed.draft))
            emit({ type: "root_degraded", step: node.id })
            emit({ type: "introspected", step: node.id })
            yield* atomicLoop(node, parsed.draft)
            return
          }
        }
        blockNode(node, reason)
      } else {
        blockNode(node, reason)
      }
    })
  // R2: run-scoped LLM goal-check cache + verdict result. `cached` lets the caller mark the transcript;
  // `evidenceFault` = an achieved:true claim without a verifiable verbatim quote (a checker fault, not a
  // model-action fault, so it must NOT accrue toward the leaf's stuck counter).
  const goalCheckCache = new Map<string, { achieved: boolean; missing: string; evidenceFault: boolean }>()
  interface GoalVerdict { readonly achieved: boolean; readonly missing: string; readonly cached: boolean; readonly evidenceFault: boolean }
  // `applyEvidence` gates the evidence rule. It is applied ONLY at the ROOT whole-task goal-check (where a
  // rubber-stamped achieved:true = a false DONE), NOT at per-step weak-leaf checks: a weak model cannot
  // reliably VERBATIM-quote its own source per step, so demanding it there blocks honest write steps and
  // stalls the run (baseline run42/43: "without verifiable evidence" nag-loop, best≈0.06). Per-step
  // achievement is backstopped by the compile/run checks and the root oracle, so evidence is not needed there.
  const runGoalCheck = (goal: string, applyEvidence: boolean): Effect.Effect<GoalVerdict> =>
    Effect.gen(function* () {
      const workspace = renderWorkspace()
      const key = Hash.sha256(`${applyEvidence ? "E" : "-"}|${goal}|${workspace}|${lastRunOutput}`)
      if (deps.goalCheckCache !== false) {
        const hit = goalCheckCache.get(key)
        if (hit) return { ...hit, cached: true }
      }
      const gc = yield* Effect.exit(deps.introspect(JhExpander.goalCheckPrompt({ goal, workspace, lastOutput: lastRunOutput })))
      if (!Exit.isSuccess(gc)) return { achieved: true, missing: "", cached: false, evidenceFault: false } // unreachable checker → don't stall; accept
      const parsed = JhExpander.parseGoalCheck(gc.value)
      let verdict = { achieved: parsed.achieved, missing: parsed.missing, evidenceFault: false }
      // Evidence rule (root-only): a whole-task success claim must quote verbatim proof from the workspace/output.
      if (deps.evidence !== false && applyEvidence && parsed.achieved) {
        const ev = (parsed.evidence ?? "").replace(/\s+/g, " ").trim()
        const material = `${workspace}\n${lastRunOutput}`.replace(/\s+/g, " ")
        if (ev.length === 0 || !material.includes(ev)) verdict = { achieved: false, missing: "goal-check claimed success without verifiable evidence", evidenceFault: true }
      }
      if (deps.goalCheckCache !== false) goalCheckCache.set(key, verdict)
      return { ...verdict, cached: false }
    })
  // improve19 — the THINK/DO split (`notes/jh-think-stage.md`). Run the optional reasoning stage for
  // this node and return the bounded plan, or undefined when the stage is off/narrowed/unusable.
  // NEVER throws and never blocks: an empty, truncated or failed think falls through to the
  // unplanned path (the improve1 ghost — "<think> ate the budget, content came back empty" — is
  // caught here rather than costing the step, which is the point of splitting the calls).
  const thinkFor = (
    nodeId: JhStep.StepID,
    kind: "decompose" | "recover" | "atomic",
    extraContext?: string,
  ): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      const think = deps.think
      if (!think) return undefined
      if (deps.thinkOn && !deps.thinkOn.includes(kind)) return undefined
      const ex = yield* Effect.exit(
        think(
          JhExpander.thinkPrompt({
            taskGoal: task.goal,
            stepGoal: goalOf(nodeId),
            context: buildContext(nodeId, extraContext),
            kind,
            ...(deps.environment !== undefined ? { environment: deps.environment } : {}),
          }),
        ),
      )
      if (!Exit.isSuccess(ex)) {
        emit({ type: "think_failed", step: nodeId, reason: "llm_unreachable" })
        return undefined
      }
      const plan = JhExpander.boundPlan(ex.value)
      if (plan === "") {
        emit({ type: "think_failed", step: nodeId, reason: "empty" })
        return undefined
      }
      emit({ type: "planned", step: nodeId, kind, plan })
      return plan
    })

  /** The plan, rendered for the DO call's context — labelled so the executor treats it as guidance,
   *  not as text to copy into a file. */
  const withPlan = (plan: string | undefined, extraContext?: string): string | undefined => {
    if (!plan) return extraContext
    const block = `YOUR PLAN FOR THIS STEP (you wrote this a moment ago — follow it):\n${plan}`
    return extraContext ? `${extraContext}\n\n${block}` : block
  }

  const buildPrompt = (
    nodeId: JhStep.StepID,
    opts: { allowDecomposition?: boolean; mustDecompose?: boolean; formatReminder?: string; extraContext?: string },
  ): JhExpander.PromptPair => {
    const cur = JhTree.get(tree, nodeId)!
    return JhExpander.introspectPrompt({
      taskGoal: task.goal,
      stepGoal: goalOf(nodeId),
      context: buildContext(nodeId, opts.extraContext),
      toolNames: deps.toolNames,
      allowDecomposition: opts.allowDecomposition ?? cur.depth < maxDepth,
      mustDecompose: opts.mustDecompose ?? false,
      formatReminder: opts.formatReminder,
      environment: deps.environment,
      lazyPlan: deps.lazyPlan !== false, // P3a: top-level-phases-only wording (false = wave-2)
    })
  }

  // improve4 P2: bubble is now an Effect — a completing PHASE is gated on a green regression suite before it
  // commits (a red test grows a fix node on the phase and stops the bubble; the phase stays expanded until
  // the suite is green). Off (phaseGateOn false) → the wave-3 synchronous walk.
  const bubble = (id: JhStep.StepID): Effect.Effect<void> =>
    Effect.gen(function* () {
      let childID: JhStep.StepID = id
      for (;;) {
        const child = JhTree.get(tree, childID)
        if (!child || child.parent === undefined) break
        const parentID = child.parent
        if (!JhTree.allChildrenCommitted(tree, parentID)) break
        // With a root gate on, the ROOT is not auto-committed here: the main loop runs a final whole-task
        // check first (and EXTENDS with a fix node if the deliverable isn't actually done).
        if ((deps.verifyGoal || deps.taskComplete) && parentID === tree.root) break
        // P2: gate the phase on the regression suite; a red test → fix node grown, stop (do not commit).
        if (phaseGateOn && (yield* runPhaseGate(parentID))) return
        tree = JhTree.setStatus(tree, parentID, "committed")
        emit({ type: "committed", step: parentID })
        childID = parentID
      }
    })
  const blockNode = (node: JhTree.Node, reason: string): void => {
    lastBlockReason = reason
    tree = JhTree.setStatus(tree, node.id, "blocked")
    emit({ type: "blocked", step: node.id, reason })
    const ancestors = JhTree.ancestors(tree, node.id) // root-first
    for (let i = ancestors.length - 1; i >= 0; i--) {
      tree = JhTree.setStatus(tree, ancestors[i]!.id, "blocked")
      emit({ type: "blocked", step: ancestors[i]!.id, reason: "child_blocked" })
    }
  }

  // C — validate a decomposition (law 7, one repair), then attach.
  const decompose = (node: JhTree.Node, drafts: ReadonlyArray<JhStep.StepDraft>): Effect.Effect<"expanded" | "blocked"> =>
    Effect.gen(function* () {
      if (node.depth >= maxDepth) {
        blockNode(node, "depth_budget")
        return "blocked" as const
      }
      let current = drafts
      for (let attempt = 0; attempt < 2; attempt++) {
        // Only DANGLING consumes (a step needs an artifact nobody makes — the §5 law-7 load-bearing
        // check) blocks the plan. duplicate_produce (store is latest-wins) and unused_produce are
        // TOLERATED — weak models mis-declare produces routinely; the per-step verify catches real
        // problems, and a hard reject on a harmless declaration error just stalls the task (§12).
        // improve3 (char run74): TOLERATE dangling consumes at the task ROOT — disk is truth there and the
        // declared dataflow is an unreliable proxy (§5 law-7 amendment); a strict reject hard-blocks the whole
        // run (the root has no parent to grow a fix sibling on). The tolerant trySoftDecompose path already did
        // this; a directly-decomposing root went through the strict check. Non-root nodes still validate.
        const errors = node.id === tree.root ? [] : JhDataflow.validate(current, deps.artifacts.ids()).filter((i) => i.code === "dangling_consumes")
        if (errors.length === 0) {
          // P3b: lazy planning — attach only the TOP level; each phase re-plans itself when reached.
          let toAttach = current
          if (deps.lazyPlan !== false) {
            const { drafts: flat, discarded } = flattenTopLevel(current)
            if (discarded > 0) emit({ type: "flattened", step: node.id, discarded })
            toAttach = flat
          }
          const attached = JhTree.attach(tree, node.id, toAttach, maxDepth)
          if (attached instanceof JhTree.AttachError) {
            blockNode(node, attached.reason === "max_depth" ? "depth_budget" : `attach_${attached.reason}`)
            return "blocked" as const
          }
          tree = attached
          emit({ type: "expanded", step: node.id, children: toAttach.length })
          return "expanded" as const
        }
        emit({ type: "dataflow_rejected", step: node.id, issues: errors.map((e) => `${e.code}:${e.artifact}`) })
        if (attempt === 1) break
        const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { mustDecompose: true, formatReminder: JhExpander.dataflowRepairReminder(errors) })))
        if (!Exit.isSuccess(ex)) {
          blockNode(node, "llm_unreachable")
          return "blocked" as const
        }
        const parsed = JhExpander.parseReply(ex.value, { fallbackGoal: goalOf(node.id) })
        if (!parsed.ok || !parsed.draft.substeps || parsed.draft.substeps.length === 0) {
          yield* structuralFailRecover(node, "dataflow") // D11: recover, don't cascade-block
          return "blocked" as const
        }
        current = parsed.draft.substeps
      }
      yield* structuralFailRecover(node, "dataflow") // D11: recover, don't cascade-block
      return "blocked" as const
    })

  // Re-introspect with mustDecompose (the force-split and budget-exhaustion paths). On a valid decomposition
  // it supersedes the leaf (the node becomes expanded). improve5 P3: when `degradeToAtomic`, a refusal (the
  // model won't decompose, or the LLM is momentarily unreachable) returns "atomic" WITHOUT blocking — the
  // caller runs the node's own atomic step (never-dead-end); otherwise it blocks with the given reason.
  const forceDecompose = (node: JhTree.Node, blockReasonIfAtomic: string, degradeToAtomic = false): Effect.Effect<"expanded" | "blocked" | "atomic"> =>
    Effect.gen(function* () {
      const forcePlan = yield* thinkFor(node.id, "decompose")
      const ex = yield* Effect.exit(
        deps.introspect(buildPrompt(node.id, { allowDecomposition: true, mustDecompose: true, ...(withPlan(forcePlan) !== undefined ? { extraContext: withPlan(forcePlan)! } : {}) })),
      )
      if (!Exit.isSuccess(ex)) {
        if (degradeToAtomic) return "atomic" as const
        blockNode(node, "llm_unreachable")
        return "blocked" as const
      }
      const parsed = JhExpander.parseReply(ex.value, { fallbackGoal: goalOf(node.id) })
      if (parsed.ok && parsed.draft.size === "needs_decomposition" && parsed.draft.substeps && parsed.draft.substeps.length > 0) {
        tree = JhTree.fill(tree, node.id, stripSubsteps(parsed.draft))
        emit({ type: "introspected", step: node.id })
        return yield* decompose(node, parsed.draft.substeps)
      }
      if (degradeToAtomic) return "atomic" as const
      blockNode(node, blockReasonIfAtomic)
      return "blocked" as const
    })

  // SOFT decomposition nudge: a top-level task (depth 0) is the WHOLE task — write + build + run +
  // verify — almost never one tool call, yet a weak model tends to emit one big atomic write_file with a
  // trivial `artifact_present` check (a "false done" that never compiles/runs). Re-prompt to decompose;
  // if the model gives a clean (dangling-free) split, expand it — otherwise FALL BACK to the atomic draft
  // (return false) rather than block, so a genuinely-simple root still works.
  const trySoftDecompose = (node: JhTree.Node): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      // The model's willingness to decompose the whole task is variable (temperature): sometimes it
      // insists on one big atomic write. RETRY a few times — a retry usually yields a proper plan.
      for (let attempt = 0; attempt < SOFT_DECOMPOSE_ATTEMPTS; attempt++) {
        const softPlan = yield* thinkFor(node.id, "decompose")
        const ex = yield* Effect.exit(
          deps.introspect(buildPrompt(node.id, { allowDecomposition: true, mustDecompose: true, ...(withPlan(softPlan) !== undefined ? { extraContext: withPlan(softPlan)! } : {}) })),
        )
        if (!Exit.isSuccess(ex)) continue
        const parsed = JhExpander.parseReply(ex.value, { fallbackGoal: goalOf(node.id) })
        const subs = parsed.ok && parsed.draft.size === "needs_decomposition" ? parsed.draft.substeps : undefined
        if (!subs || subs.length === 0) continue
        // P3b: lazy planning — attach only the TOP-LEVEL phases (each re-plans itself when reached). This is
        // the root plan, so shrinking it is the structural attack on I3 (a smaller reply is harder to malform).
        let toAttach: ReadonlyArray<JhStep.StepDraft> = subs
        if (deps.lazyPlan !== false) {
          const { drafts: flat, discarded } = flattenTopLevel(subs)
          if (discarded > 0) emit({ type: "flattened", step: node.id, discarded })
          toAttach = flat
        }
        // Attach a structurally-valid plan REGARDLESS of declared dataflow: for file-based work the real
        // dependency is the file on disk (cwd), not the artifact store — a weak model's consumes/produces
        // ids are an unreliable proxy, and a dangling DECLARATION doesn't mean the step will fail (§9/§12).
        // Execution + the verify-gate are the real checks.
        const attached = JhTree.attach(tree, node.id, toAttach, maxDepth)
        if (attached instanceof JhTree.AttachError) continue
        tree = attached
        emit({ type: "introspected", step: node.id })
        emit({ type: "expanded", step: node.id, children: toAttach.length })
        return true
      }
      return false
    })

  // improve4 P1/P2: the shared regression SWEEP — re-run the digest-stale REGISTERED tests, each rebuilt
  // from the CURRENT sources (the normal staleness make-path) then executed. Stops at the FIRST red test
  // (the model must fix it before we trust the rest). Bounded by MAX_SUITE_MS; skipped tests are NAMED
  // (never silently partial — L4). Pure of policy: it logs nothing and grows no node; the P1 (per-edit
  // preempt) and P2 (phase gate) callers decide what a red test MEANS.
  interface SweepResult {
    readonly green: number
    readonly red: number // 0 or 1 — we stop at the first NON-SUSPECT red
    readonly redTest?: { readonly command: string; readonly detail: string; readonly priorFailures: number }
    readonly skipped: ReadonlyArray<string>
    /** improve6 P3: a SUSPECT test also failed — reported for visibility, never a veto. */
    readonly suspectNote?: string
    /** improve6 P3: a test crossed a suspicion threshold THIS sweep — the caller grows its one-time fix node. */
    readonly newlySuspect?: string
  }
  const regressionSweep = (): Effect.Effect<SweepResult> =>
    Effect.gen(function* () {
      if (!regression || !staleness) return { green: 0, red: 0, skipped: [] }
      const suspectOn = deps.suspectTests !== false
      // Prune tests whose product was deleted/renamed (log-free), then select the digest-stale ones.
      regression.prune((command) => staleness!.productPresent(command, snapFiles()))
      const curDigest = staleness.sourceDigestNow(snapFiles())
      const staleAll = regression.staleTests(() => curDigest)
      if (staleAll.length === 0) return { green: 0, red: 0, skipped: [] }
      // improve6 P3: non-suspect tests first (they can veto); suspect tests run LAST and never veto.
      const stale = suspectOn ? [...staleAll.filter((t) => !t.suspect), ...staleAll.filter((t) => t.suspect)] : staleAll
      const budget = deps.maxSuiteMs ?? MAX_SUITE_MS
      const startMs = now()
      let green = 0
      let redTest: { readonly command: string; readonly detail: string; readonly priorFailures: number } | undefined
      const skipped: string[] = []
      let suspectNote: string | undefined
      let newlySuspect: string | undefined
      let ran = 0
      for (const t of stale) {
        // Budget: once elapsed exceeds it, SKIP the rest (always run at least one — a 0 budget still progresses).
        if (ran > 0 && now() - startMs >= budget) {
          skipped.push(t.command)
          continue
        }
        ran++
        // Rebuild the test's product chain from the current sources (the normal staleness path), then run it.
        let curSnap = snapFiles()
        let buildErr: string | undefined
        for (const sp of staleness.staleChainFor(t.command, curSnap)) {
          if (!sp.rebuild) continue // an un-attributed product — let the run surface it, don't guess a command
          const rb = yield* deps.runner.run({ command: sp.rebuild, cwd: deps.cwd, timeoutMs: checkTimeout })
          const rbAfter = snapFiles()
          staleness.recordAction({ tool: "run", ok: rb.exitCode === 0 && !rb.timedOut, command: sp.rebuild, before: curSnap, after: rbAfter })
          curSnap = rbAfter
          if (rb.exitCode !== 0 || rb.timedOut) {
            // improve6 P1 (L4 never lie): a recorded rebuild can be a COMPOUND whose failing segment is the
            // test run itself, not the compiler — say "build/run chain", never claim a compile failure.
            buildErr = `the test's build/run chain FAILED after your edit:\n${rb.output.slice(-REGRESSION_TAIL)}`
            break
          }
        }
        let ok: boolean
        let detail: string
        if (buildErr !== undefined) {
          ok = false
          detail = buildErr
        } else {
          const r = yield* deps.runner.run({ command: t.command, cwd: deps.cwd, timeoutMs: checkTimeout })
          staleness.recordAction({ tool: "run", ok: r.exitCode === 0 && !r.timedOut, command: t.command, before: curSnap, after: snapFiles() })
          ok = r.exitCode === 0 && !r.timedOut && (t.expect ? r.output.includes(t.expect) : true)
          detail = r.timedOut ? `timed out\n${r.output.slice(-REGRESSION_TAIL)}` : r.output.slice(-REGRESSION_TAIL)
          // improve6 P3 registration hygiene: a PASSING test whose output carries implicit-declaration
          // warnings likely misses its unit's header — mark it; its first failure is suspect-eligible fast.
          if (ok && suspectOn && r.output.includes("implicit declaration")) regression.markUnsanitized(t.command)
        }
        regression.recordResult(t.command, ok, staleness.sourceDigestNow(snapFiles()))
        if (ok) {
          green++
          scoreAtFirstFail.delete(t.command)
          continue
        }
        if (t.suspect) {
          // improve6 P3: suspect tests report, never veto.
          suspectNote ??= `\n(note: the SUSPECT test \`${t.command}\` also failed — it is excluded from gating because it may itself be wrong; fix or replace it when convenient.)`
          continue
        }
        // improve6 P3 suspicion checks (in order): the unsanitized fast-path; the test's OWN file failing to
        // build (compiler diagnostics naming a file no OTHER registered test references — run101's t_arctan);
        // red for SUSPECT_AFTER consecutive rounds while the program's measured score did NOT regress.
        if (suspectOn) {
          if (t.failures === 0) scoreAtFirstFail.set(t.command, bestScore)
          const newFailures = t.failures + 1
          const ownFile = buildErr !== undefined ? exclusiveSourceIn(t.command, buildErr) : undefined
          const scoreGuard = bestScore >= (scoreAtFirstFail.get(t.command) ?? Number.POSITIVE_INFINITY)
          const suspicious =
            (t.unsanitized && newFailures >= 1) || ownFile !== undefined || (newFailures >= SUSPECT_AFTER && scoreGuard)
          if (suspicious) {
            regression.markSuspect(t.command)
            newlySuspect ??= t.command
            suspectNote ??= `\n(note: the test \`${t.command}\` was just marked SUSPECT${ownFile ? ` — its own file ${ownFile} does not build` : ""}; it is excluded from gating until fixed or replaced.)`
            continue
          }
        }
        redTest = { command: t.command, detail, priorFailures: t.failures }
        break
      }
      lastSweepGreen = green // improve6 P2: the keep-best suite-green tiebreak reads the latest sweep
      return { green, red: redTest ? 1 : 0, redTest, skipped, suspectNote, newlySuspect }
    })

  // improve6 P3: the source files a test command references that NO OTHER registered test references — the
  // test's OWN file(s), shape-derived (tokens with a non-product extension), never by naming convention (L3).
  // Returns the first such file the diagnostics mention (`<file>:` — a compiler error inside it), else undefined.
  const exclusiveSourceIn = (command: string, diagnostics: string): string | undefined => {
    if (!regression) return undefined
    const tokens = (cmd: string): Set<string> => new Set(cmd.split(/[\s"'=]+/).filter(Boolean).map(baseName))
    const key = JhRegression.normalizeCommand(command)
    const otherRefs = new Set<string>()
    for (const o of regression.all()) if (o.command !== key) for (const r of tokens(o.command)) otherRefs.add(r)
    const productish = /\.(exe|o|out|obj|dll|so|a|lib|dylib|class)$/i
    for (const r of tokens(command)) {
      if (!r.includes(".") || productish.test(r) || otherRefs.has(r)) continue
      if (diagnostics.includes(`${r}:`)) return r
    }
    return undefined
  }

  // improve4 P1 (§I6): the PER-EDIT preempt. After a source edit, sweep the registered tests BEFORE the
  // leaf's own check; a test that passed before and FAILS now preempts the leaf's verification and NAMES the
  // changed file(s), so the model fixes the FOUNDATION instead of thrashing the formula on it (run75: `pi.c`
  // edited 74× while the bug was in `bigint.c`). Returns a failing VerifyResult on a regression, else undefined.
  const runRegressionSuite = (nodeId: JhStep.StepID, changed: ReadonlyArray<string>): Effect.Effect<{ readonly result: JhVerifier.VerifyResult; readonly damage: boolean } | undefined> =>
    Effect.gen(function* () {
      if (!regression) return undefined
      const sweep = yield* regressionSweep()
      if (sweep.skipped.length > 0) emit({ type: "suite", step: nodeId, green: sweep.green, red: sweep.red, skipped: sweep.skipped.length })
      // improve6 P3: the test-fix node must be a SIBLING (attached to the leaf's parent) — a child appended
      // under a leaf that later commits is orphaned (nextPending never descends into committed subtrees).
      if (sweep.newlySuspect) yield* growTestFixNode(JhTree.get(tree, nodeId)?.parent ?? nodeId, sweep.newlySuspect)
      if (!sweep.redTest) return undefined
      emit({ type: "regression", step: nodeId, command: sweep.redTest.command, changed })
      const where = changed.length > 0 ? changed.join(", ") : "the file(s) you just edited"
      const budget = deps.maxSuiteMs ?? MAX_SUITE_MS
      const skipNote = sweep.skipped.length > 0 ? `\n(note: ${sweep.skipped.length} other registered test(s) were not re-run this round due to the ${Math.round(budget / 1000)}s suite budget: ${sweep.skipped.join(", ")})` : ""
      const greenNote = sweep.green > 0 ? ` (${sweep.green} other registered test(s) still pass)` : ""
      // improve6 P1.3/P2: never lie about the gradient. A FRESH break is damage; a STILL-failing test is
      // progress-neutral information ("keep working on exactly this") — EXCEPT when the red is COMPILER
      // breakage (diagnostics-shaped output): a workspace that does not BUILD is damage every round, or
      // repeated build breakage under a covering test would evade the auto-revert floor entirely.
      const fresh = sweep.redTest.priorFailures === 0
      const compilerBroken = /(^|\s)([\w./\\-]+\.[a-z]{1,4}):\d+(:\d+)?:\s*(fatal\s+)?error/i.test(sweep.redTest.detail)
      const detail = fresh
        ? `REGRESSION: \`${sweep.redTest.command}\` passed before your edit and FAILS now — the change you just made to ${where} broke previously-verified behavior${greenNote}. Fix THOSE files (or git-revert) before anything else. Test output: ${sweep.redTest.detail}${skipNote}${sweep.suspectNote ?? ""}`
        : `REGRESSION SUITE: \`${sweep.redTest.command}\` is STILL failing (round ${sweep.redTest.priorFailures + 1}) after your change to ${where}${greenNote} — keep working on exactly this. Test output: ${sweep.redTest.detail}${skipNote}${sweep.suspectNote ?? ""}`
      return { result: { ok: false, detail }, damage: fresh || compilerBroken }
    })

  // improve6 P3: tests are code too — a test marked SUSPECT gets ONE fix node (and never a veto): re-derive
  // the TEST itself from the unit's header with a small, definitely-correct case (run101's t_arctan wall).
  const growTestFixNode = (parentID: JhStep.StepID, command: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (deps.suspectTests === false || testFixGrown.has(command) || JhTree.size(tree) >= maxTotalSteps) return
      testFixGrown.add(command)
      emit({ type: "suspect_test", step: parentID, command })
      const draft: JhStep.StepDraft = {
        goal: `The test run by \`${command}\` appears to be WRONG itself (it kept failing while the program's measured output improved, or the test's own file does not build). Re-derive the TEST: include the unit's real header, call the real functions with their real signatures, and use a SMALL hand-computable case whose expected value is definitely correct. Do NOT weaken it into a tautology — a trivial-but-correct case beats an impossible one. Then compile and run it until it passes.`,
        size: "atomic",
        success: "the replaced test compiles, runs, and passes",
      }
      const appended = JhTree.appendChild(tree, parentID, draft, maxDepth)
      if (!(appended instanceof JhTree.AttachError)) {
        tree = appended
        emit({ type: "expanded", step: parentID, children: JhTree.get(tree, parentID)!.children.length })
      }
    })

  // improve4 P2: the PHASE GATE. At a completing phase (and before the root's oracle), sweep the registered
  // tests and LOG the result; a red test means the phase must NOT complete — grow a fix node on it that
  // names the failing test (the existing appendChild path). Returns true when the caller must NOT commit
  // this node (a red suite — a fix node was grown, or the step budget blocked growth → the run blocks
  // rather than false-completing; never-dead-end holds via the global budget).
  const runPhaseGate = (nodeId: JhStep.StepID): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (!regression) return false
      const sweep = yield* regressionSweep()
      emit({ type: "suite", step: nodeId, green: sweep.green, red: sweep.red, skipped: sweep.skipped.length })
      if (sweep.newlySuspect) yield* growTestFixNode(nodeId, sweep.newlySuspect) // improve6 P3: suspects never veto the phase
      if (!sweep.redTest) return false
      if (JhTree.size(tree) < maxTotalSteps) {
        const baseGoal = JhTree.get(tree, nodeId)!.draft.goal
        yield* growFixNode(nodeId, baseGoal, `this phase cannot complete while a previously-passing test fails: \`${sweep.redTest.command}\` — ${sweep.redTest.detail}${sweep.suspectNote ?? ""}`, "the previously-passing test passes again", sweep.redTest.command)
      }
      return true // red suite → do not commit this phase
    })

  // E — the atomic execution loop.
  const atomicLoop = (node: JhTree.Node, initialDraft: JhStep.StepDraft): Effect.Effect<void> =>
    Effect.gen(function* () {
      let draft = initialDraft
      let currentTool = draft.tool ?? ""
      let currentArgs: Readonly<Record<string, unknown>> = draft.args ?? {}
      // `let`, not `const`: the recovery loop can correct the command — the CHECK must move with it, else
      // a fixed action re-runs against a stale check forever (iter 19: action `.\pi.exe` ok, but the frozen
      // check still ran `pi.exe` → "not recognized" every time).
      let check: JhStep.Check = draft.check ?? { type: "artifact_present" }
      // Budget is seeded by the prior and fixed for this leaf (telemetry is recorded but does not
      // self-escalate the budget mid-leaf — else a trivial-prior leaf could never exhaust; see ledger).
      const budget = JhBudget.budgetFor(draft.difficulty_prior ?? undefined, JhBudget.emptyTelemetry)
      const errorCounts = new Map<string, number>() // verify-failure signature → how many times seen (THIS leaf)
      // R1 idempotence (per-leaf): the digest + detail of the last EXECUTED check that FAILED. An identical
      // check over an unchanged workspace cannot newly pass, so we return the cached fail (which DOES count
      // toward stuck — an unchanged retry IS the rut) instead of re-running the same command.
      let lastFailDigest: string | undefined
      let lastFailDetail = ""
      for (;;) {
        // improve7.1: the wall can expire MID-LEAF — a leaf's exploration loop can run for many minutes
        // without returning to the outer scheduler, so the probe-11550 run sailed past its wall inside a
        // rut and the harness backstop race had to kill it, skipping the terminal best-restore. Bail out
        // of the leaf (node stays pending); the outer loop's wall check then finalizes THROUGH the restore.
        if (deps.budget && deps.budget.wallMs > 0 && deps.budget.now() - deps.budget.startedAt >= deps.budget.wallMs) return
        if (deps.aborted?.()) return // improve11 P1: a losing racer bails mid-leaf; the outer loop finalizes
        updateTelemetry(node.id, (t) => ({ ...t, attempts: t.attempts + 1 }))
        const before = snapFiles() // R1: workspace fingerprint BEFORE the action (source→product build graph)
        // improve5 P2: the edited file + its PRE-IMAGE (for tool-level undo if the tx gate rejects the edit).
        const editedFile = SOURCE_EDIT_TOOLS.has(currentTool) && typeof currentArgs.path === "string" ? String(currentArgs.path) : undefined
        const preImage = txEditsOn && editedFile ? deps.listFiles?.().find((f) => baseName(f.name) === baseName(editedFile))?.content : undefined
        emit({ type: "action", step: node.id, tool: currentTool })
        // improve7 P2 (C7): a file locked to coordinates intercepts edit_file BEFORE execution — the model
        // has proven it cannot reproduce this file's bytes (COORD_AFTER consecutive misses); redirect it to
        // the coordinate editor instead of letting quote-drift burn the wall (run111: 23× on bigint.c).
        const coordBase = deps.coordMode !== false && currentTool === "edit_file" && editedFile ? baseName(editedFile) : undefined
        // improve10 P2: past COORD_CUMULATIVE lifetime misses the lock is STICKY (run140's interleave evasion).
        const coordIntercepted = coordBase !== undefined && (coordLocked.has(coordBase) || (editMissesTotal.get(coordBase) ?? 0) >= COORD_CUMULATIVE)
        const observation: JhBasicTools.Observation = coordIntercepted
          ? { ok: false, output: `edit_file is DISABLED for ${coordBase} — your old_string did not match the file ${COORD_AFTER} times in a row. Use replace_lines {path, first_line, last_line, new_content} with the \`N→\` line numbers shown in the workspace view above; you do NOT need to reproduce the old text — the numbered lines are the ground truth.`, artifacts: new Map() }
          : yield* deps.executor.run({ tool: currentTool, args: currentArgs, produces: draft.produces ?? [], cwd: deps.cwd })
        if (currentTool === "run" && observation.ok) {
          lastRunOutput = observation.output // remember the program's stdout for the goal-checks
          sampleScore(node.id) // R3: track the best progress score + snapshot on improvement
          // improve7 P1 (K5): the sampler armed a drop-restore (consecutive below-best scores) — perform it
          // here (Effect land) and tell the NEXT introspection what happened and what to do.
          if (pendingDropRestore) {
            pendingDropRestore = false
            const did = yield* restoreBest(node.id, "drop")
            if (did)
              pendingRevertMessage = `your recent edits made the measured output WORSE — the harness has RESTORED the best-known state (progress score ${bestScore.toFixed(3)}). Improve FROM this state with a SMALL, different change; do not repeat the reverted approach. (After any source edit, recompile before re-running.)`
          }
        }
        emit({ type: "observation", step: node.id, ok: observation.ok })
        if (staleness && !coordIntercepted)
          staleness.recordAction({ tool: currentTool, ok: observation.ok, command: typeof currentArgs.command === "string" ? currentArgs.command : undefined, before, after: snapFiles() })
        // improve7 P2 (C7): count consecutive per-file mis-quotes; at COORD_AFTER the file locks to
        // coordinates (the interception above); ANY successful source edit on the file clears lock + count.
        if (deps.coordMode !== false && editedFile) {
          const base = baseName(editedFile)
          if (currentTool === "edit_file" && !coordIntercepted && !observation.ok && observation.output.startsWith("old_string not found in")) {
            const n = (editMisses.get(base) ?? 0) + 1
            editMisses.set(base, n)
            const total = (editMissesTotal.get(base) ?? 0) + 1
            editMissesTotal.set(base, total)
            if ((n >= COORD_AFTER || total >= COORD_CUMULATIVE) && !coordLocked.has(base)) {
              coordLocked.add(base)
              emit({ type: "coord_mode", step: node.id, file: base })
            }
          } else if (SOURCE_EDIT_TOOLS.has(currentTool) && observation.ok) {
            editMisses.delete(base)
            coordLocked.delete(base)
          }
        }

        // improve5 P2: TRANSACTIONAL edit gate — syntax-check a source edit via the edited file's OWN
        // per-file object compile BEFORE trusting it; a non-compiling edit is REJECTED and the file restored
        // to its pre-image (prevent the damage, don't heal it later — run89's 8 revert cycles). Opportunistic:
        // only when staleness knows a `-c` compile for the file (never invents one — L4).
        let txRejected: JhVerifier.VerifyResult | undefined
        let txSig: string | undefined // improve6 P1: a STABLE per-file stuck signature (tx:<file>) — the varying compiler tail evaded the counter (K3)
        if (txEditsOn && staleness && observation.ok && editedFile && preImage !== undefined) {
          const base = baseName(editedFile)
          if ((gateRejects.get(base) ?? 0) >= GATE_YIELD_AFTER) {
            // improve6 P1: the gate YIELDS — this attempt lands regardless, restoring iteration with the
            // attempt VISIBLE in the workspace; the rebuild/regression machinery takes over from here.
            gateRejects.delete(base)
            emit({ type: "gate_yielded", step: node.id, file: base })
          } else {
            // improve6 P1 (gate surgery): the gate runs ONLY the compile SEGMENT for this file (staleness
            // extracts it — never the recorded build+TEST compound, which rejected 13/15-passing edits with
            // a false "does not compile" 73× in run104). Exit≠0 here IS a compiler failure, so the message
            // is truthful structurally; test failures never reject (they land and report via the sweep).
            const cmd = staleness.objectCompileFor(editedFile)
            if (cmd) {
              const beforeCompile = snapFiles()
              const rb = yield* deps.runner.run({ command: cmd, cwd: deps.cwd, timeoutMs: checkTimeout })
              staleness.recordAction({ tool: "run", ok: rb.exitCode === 0 && !rb.timedOut, command: cmd, before: beforeCompile, after: snapFiles() })
              if (rb.exitCode !== 0 || rb.timedOut) {
                const beforeRestore = snapFiles()
                yield* deps.executor.run({ tool: "write_file", args: { path: editedFile, content: preImage }, produces: [], cwd: deps.cwd }) // tool-level undo
                staleness.recordAction({ tool: "write_file", ok: true, before: beforeRestore, after: snapFiles() })
                emit({ type: "edit_rejected", step: node.id, file: base })
                gateRejects.set(base, (gateRejects.get(base) ?? 0) + 1)
                txSig = `tx:${base}`
                txRejected = { ok: false, detail: `edit NOT applied — ${base} no longer compiles:\n${rb.output.slice(-REGRESSION_TAIL)}\nThe file is UNCHANGED (restored to the last version). Fix the compiler error above with a SMALLER edit, then reapply.` }
              } else {
                gateRejects.delete(base) // a clean compile resets the consecutive-rejection count
              }
            }
          }
        }

        // improve4 P1: after a successful SOURCE edit, re-run the digest-stale registered tests BEFORE this
        // leaf's own check — a previously-green test the edit broke preempts everything and names the file.
        // (Skipped when the tx gate rejected the edit: the workspace is UNCHANGED, so there is nothing to regress.)
        let regressionPreempt: JhVerifier.VerifyResult | undefined
        let preemptDamage = false // improve6 P2: damage is decided by failure CLASS (fresh break / compiler breakage), not message prefix
        if (regression && observation.ok && !txRejected && SOURCE_EDIT_TOOLS.has(currentTool)) {
          const beforeHashes = new Map(before.map((f) => [f.name, f.hash]))
          const changed = snapFiles()
            .filter((f) => beforeHashes.get(f.name) !== f.hash)
            .map((f) => f.name)
          const preempt = yield* runRegressionSuite(node.id, changed)
          regressionPreempt = preempt?.result
          preemptDamage = preempt?.damage ?? false
        }

        // A STALE-artifact bookkeeping fail must NOT feed the stuck counter (it asks for a recompile, it is
        // not a model rut). Set only when a check ran a product whose sources changed but had no rebuild.
        let noCountSig = false
        let vr: JhVerifier.VerifyResult
        if (txRejected) {
          vr = txRejected // improve5 P2: the edit didn't compile and was reverted — the workspace never changed
        } else if (regressionPreempt) {
          vr = regressionPreempt // the edit broke a locked test — skip the leaf's own check entirely
        } else if (observation.ok) {
          const producedPresent = (draft.produces ?? []).every((p) => {
            const c = observation.artifacts.get(p.id)
            return c !== undefined && c.length > 0
          })
          // R1: before executing a compile/run/output_equals check, refuse to run a STALE product — auto-re-run
          // the model's own last successful producing command(s) (the make move; log `refreshed`). Rebuild
          // EVERY stale product in production order (a chain pi.c→pi.o→pi.exe rebuilds pi.o then pi.exe),
          // skipping the one the check itself (re)builds; a product we never saw produced is reported stale.
          // Then short-circuit an identical failing check over an unchanged workspace (idempotence).
          const checkCommand = "command" in check ? check.command : undefined // compile/run/output_equals only
          let curSnap = snapFiles()
          let short: JhVerifier.VerifyResult | undefined
          if (staleness && checkCommand !== undefined) {
            // P5 (I4): rebuild only the check's products + their production chain (not EVERY stale product);
            // targetedRebuild:false = wave-2 rebuild-all.
            const staleToRebuild = deps.targetedRebuild === false ? staleness.allStale(curSnap) : staleness.staleChainFor(checkCommand, curSnap)
            for (const sp of staleToRebuild) {
              if (sp.rebuild === checkCommand) continue // the check itself (re)builds this product — don't pre-run it
              if (sp.rebuild) {
                emit({ type: "refreshed", step: node.id, command: sp.rebuild })
                const rb = yield* deps.runner.run({ command: sp.rebuild, cwd: deps.cwd, timeoutMs: checkTimeout })
                const rbAfter = snapFiles()
                staleness.recordAction({ tool: "run", ok: rb.exitCode === 0 && !rb.timedOut, command: sp.rebuild, before: curSnap, after: rbAfter })
                curSnap = rbAfter
                if (rb.exitCode !== 0 || rb.timedOut) {
                  // A REAL compile error on the edited source — feed it to recovery; it counts toward stuck.
                  short = { ok: false, detail: `REBUILD FAILED — the edited source no longer compiles:\n${rb.output.slice(-2000)}` }
                  break
                }
              } else {
                short = { ok: false, detail: `STALE ARTIFACT — ${sp.file} was built before the latest source edits; rebuild it (recompile) before re-checking` }
                noCountSig = true
                break
              }
            }
          }
          if (short) {
            vr = short
          } else if (staleness && lastFailDigest !== undefined && staleness.checkDigest(check, curSnap) === lastFailDigest) {
            vr = { ok: false, detail: `${lastFailDetail}\n(nothing has changed since the last attempt — a repeat run cannot pass; change the source or the command)` }
          } else {
            vr = yield* JhVerifier.verify({ check, cwd: deps.cwd, runner: deps.runner, fileExists: (rel) => deps.fileExists(rel, deps.cwd), producedPresent, defaultTimeoutMs: checkTimeout })
            // Record artifacts the CHECK's command PRODUCED (e.g. pi.o from a `gcc -c pi.c` compile check) so a
            // later source edit auto-rebuilds them instead of nagging — the D1 gap baseline run39/40 exposed
            // (recordAction previously saw only ACTION runs + rebuilds, never verify-check runs).
            if (staleness && checkCommand !== undefined) staleness.recordAction({ tool: "run", ok: vr.ok, command: checkCommand, before: curSnap, after: snapFiles() })
            if (staleness && !vr.ok) {
              lastFailDigest = staleness.checkDigest(check, curSnap)
              lastFailDetail = vr.detail
            }
          }
        } else {
          vr = { ok: false, detail: observation.output }
        }
        // STRICT goal-achievement verification (owner #5): a WEAK mechanical check (artifact_present /
        // file_exists) passing does NOT prove the step's GOAL is met — a write that never compiled/ran.
        // Ask the model to judge achievement against the workspace; if not achieved, demote to a verify
        // FAIL so the leaf keeps exploring (compile/run/verify). This kills the "false done".
        if (vr.ok && deps.verifyGoal && (check.type === "artifact_present" || check.type === "file_exists")) {
          const res = yield* runGoalCheck(goalOf(node.id), false) // R2: cached; NO evidence (per-step — see runGoalCheck)
          const marker = res.cached ? " (cached — state unchanged)" : ""
          if (!res.achieved) {
            vr = { ok: false, detail: (res.evidenceFault ? "goal-check claimed success without verifiable evidence" : `goal not yet achieved — ${res.missing || "the deliverable is not produced/verified"}`) + marker }
            // an evidence fault is a CHECKER fault, not a model-action rut — it must not accrue toward stuck.
            if (res.evidenceFault) noCountSig = true
          } else if (res.cached) {
            vr = { ok: true, detail: "goal achieved" + marker } // surface the cache hit (no LLM call spent)
          }
        }
        // R4 forced-analyze: an "analyze" node's job is to PRODUCE diagnostics — a passing check that emitted
        // no labeled NAME=value lines has not instrumented anything (run-30's 0-printf rut). Demote it.
        if (vr.ok && analyzeNodes.has(node.id) && !hasInstrumentation(lastRunOutput)) {
          vr = { ok: false, detail: "no labeled intermediate values (NAME=value lines) in the output — add the printf instrumentation, recompile, and run" }
        }
        // D12 (char run46): an ATOMIC ROOT (soft-decompose fell back to one leaf) commits directly and
        // bypasses the root-completion gate + the taskComplete oracle → a false-done. Gate the root's own
        // commit through the precise oracle: it cannot declare the whole task done unless taskComplete agrees.
        if (vr.ok && node.id === tree.root && deps.taskComplete) {
          const tc = deps.taskComplete({ workspace: renderWorkspace(), lastOutput: lastRunOutput })
          if (!tc.done) vr = { ok: false, detail: `the whole task is not done yet — ${tc.detail}` }
        }
        emit({ type: "verification", step: node.id, ok: vr.ok, detail: vr.detail })
        // improve9 P2: a green verification blesses the CURRENT workspace text — capture it so the
        // finalize drift check can tell a verified tail from unverified surgery.
        if (vr.ok && deps.keepBest !== false && deps.listFiles)
          lastGreenFiles = new Map(deps.listFiles().filter((f) => !f.content.startsWith("<compiled binary")).map((f) => [f.name, f.content]))

        if (vr.ok) {
          buildDamage = 0 // improve3 P1: a green verify clears the consecutive-build-damage counter
          // improve4 P1: register a passing run/output_equals check that EXECUTES a workspace product as a
          // persistent regression test (keyed by its command); re-registration refreshes the digest. A
          // compile-only check never registers (builds are the staleness tracker's job — its type is excluded).
          if (regression && staleness && (check.type === "run" || check.type === "output_equals") && staleness.referencesProduct(check.command)) {
            const key = JhRegression.normalizeCommand(check.command)
            const first = !regression.all().some((t) => t.command === key)
            regression.register({ command: check.command, expect: check.type === "run" ? check.expect : check.expected, depsDigest: staleness.sourceDigestNow(snapFiles()) })
            if (first) emit({ type: "test_registered", step: node.id, command: key })
          }
          for (const p of draft.produces ?? []) {
            const content = observation.artifacts.get(p.id)
            if (content !== undefined) deps.artifacts.put(p, content)
          }
          tree = JhTree.setStatus(tree, node.id, "committed")
          emit({ type: "committed", step: node.id })
          yield* bubble(node.id)
          yield* checkpoint()
          return
        }

        updateTelemetry(node.id, (t) => ({ ...t, verifierFails: t.verifierFails + 1 }))
        // Past the budget, keep exploring while the error keeps CHANGING (real progress) and under the cap.
        // "stuck" = the SAME error signature seen STUCK_REPEATS times (afpro changing-vs-stuck) — NOT merely a
        // 2nd occurrence: a weak model that repeats one mistake once (e.g. a PATH-less gcc) still deserves a
        // few more shots; temperature variance breaks the loop (iters 23–24 blocked after just 2 repeats).
        // improve6 P1: gate rejections count under a stable per-file signature; improve7 P2: so do
        // coordinate-mode interceptions (`coord:<file>`) — a model that refuses coordinates still escalates.
        const sig = txSig ?? (coordIntercepted ? `coord:${coordBase}` : errorSig(vr.detail))
        // A STALE-artifact bookkeeping fail (noCountSig) never accrues toward "stuck" — it is not a model rut,
        // just a signal to recompile (which the next step does). Everything else counts (incl. idempotence).
        let seen = errorCounts.get(sig) ?? 0
        if (!noCountSig) {
          seen += 1
          errorCounts.set(sig, seen)
        }
        const stuck = seen >= STUCK_REPEATS
        const attempts = telemetryOf(node.id).attempts

        // improve10 P1 (§K6): NEVER-GREEN suspicion — an UNREGISTERED product-executing check failing
        // with a BYTE-IDENTICAL detail across NEVERGREEN_AFTER distinct source states is oracle-suspect
        // (same failure × different code ⇒ the TEST is the invariant). Grow ONE re-derive-the-TEST
        // sibling (L2: 3/3 wave-9 re-derives rewrote the SOURCE into the same rut).
        if (
          deps.neverGreen !== false &&
          staleness &&
          !txRejected &&
          !regressionPreempt &&
          (check.type === "run" || check.type === "output_equals") &&
          staleness.referencesProduct(check.command)
        ) {
          const key = JhRegression.normalizeCommand(check.command)
          const registeredAlready = regression?.all().some((t) => t.command === key) ?? false
          if (!registeredAlready && !neverGreenGrown.has(key)) {
            const digestNow = staleness.sourceDigestNow(snapFiles())
            const detailNow = vr.detail.slice(0, 400)
            const prev = neverGreenFails.get(key)
            if (!prev || prev.detail !== detailNow) {
              neverGreenFails.set(key, { detail: detailNow, count: 1, lastDigest: digestNow })
            } else if (prev.lastDigest !== digestNow) {
              prev.count += 1
              prev.lastDigest = digestNow
              const parentID = JhTree.get(tree, node.id)?.parent
              if (prev.count >= NEVERGREEN_AFTER && parentID !== undefined && JhTree.size(tree) < maxTotalSteps) {
                neverGreenGrown.add(key)
                const ngDraft: JhStep.StepDraft = {
                  goal: `The check \`${check.command}\` has FAILED IDENTICALLY across ${prev.count} different versions of the source — the TEST'S EXPECTED VALUES are the likely bug (hand-computed constants are error-prone; the program may already be CORRECT). Re-derive the TEST, not the source: recompute every expected value from FIRST PRINCIPLES, digit by digit — or REPLACE the case with one whose answer is trivially checkable (e.g. 1+1, 10/3, one small carry). A small correct case beats an impressive wrong one. Then re-run the check.`,
                  size: "atomic",
                  success: "the check passes with honestly re-derived expected values",
                }
                const appended = JhTree.appendChild(tree, parentID, ngDraft, maxDepth)
                if (!(appended instanceof JhTree.AttachError)) {
                  tree = appended
                  emit({ type: "test_never_green", step: node.id, command: key })
                  emit({ type: "expanded", step: parentID, children: JhTree.get(tree, parentID)!.children.length })
                }
              }
            }
          }
        }

        // improve3 P1 (owner #1): the harness OWNS reverting. Track consecutive build-DAMAGING edits — an
        // edit_file/write_file whose compile or staleness-rebuild then failed — and after AUTO_REVERT_AFTER of
        // them, RESTORE the last verified checkpoint (the model keeps damaging the file over 10+ edits and won't
        // git_revert itself — §I2 hit 4/6 wave-2 runs). Any other failure (wrong output on a compiling build)
        // means the build is fine → reset the counter.
        // improve4 P1: a REGRESSION preempt (the edit broke a locked test) is build damage too — it feeds the
        // auto-revert path (repeated regression damage → the harness restores the last verified state).
        // improve5 P2: a tx-REJECTED edit is NOT damage (the file was restored; nothing was harmed) — never count it.
        // improve6 P2 (gradient-aware): damage = a FRESH break or COMPILER breakage (preemptDamage, decided
        // by failure class in runRegressionSuite) — a still-failing test after an edit is NOT damage (an
        // edit that reduces failures from 5 to 2 must never trigger the revert machinery even though red
        // remains; run102's 5/6-passing iteration). The compile-check arm counts ONLY when the leaf's OWN
        // compile check produced the failure — a suite preempt must not masquerade as compile damage.
        const buildDamaged =
          !txRejected &&
          SOURCE_EDIT_TOOLS.has(currentTool) &&
          (regressionPreempt !== undefined ? preemptDamage : vr.detail.startsWith("REBUILD FAILED") || check.type === "compile")
        buildDamage = buildDamaged ? buildDamage + 1 : 0
        if (autoRevertOn && buildDamage >= AUTO_REVERT_AFTER) {
          const beforeRevert = snapFiles()
          const rv = yield* deps.revertWorkspace!()
          if (rv.ok) {
            buildDamage = 0
            emit({ type: "reverted", step: node.id, reason: sig })
            // Re-sync staleness: the revert changed source files outside any tool action. Feed it as a
            // model-written change so product digests stay coherent — the next check auto-rebuilds the products
            // (now stale vs the reverted sources) through the normal path. The checkpoint is made ONLY after a
            // verified commit, so the restored state is known to compile (no explicit confirm-green needed).
            if (staleness) staleness.recordAction({ tool: "write_file", ok: true, before: beforeRevert, after: snapFiles() })
            // Delivered to the NEXT introspection (recovery re-introspect or the grown fix node) via buildContext.
            pendingRevertMessage =
              "IMPORTANT: your last edits kept breaking the build and could not be repaired — the harness has RESTORED the last verified working state. The files are exactly as they were after the last successful step. Do NOT retry the same edit. Make a SMALLER, DIFFERENT change (one function, a few lines at a time), recompile, and verify it before editing anything else."
          } else {
            autoRevertOn = false // never loop on a broken revert
            emit({ type: "reverted", step: node.id, reason: `revert unavailable — ${rv.detail}` })
          }
        }

        if (attempts > budget && (stuck || attempts >= EXPLORE_CAP)) {
          const parentID = JhTree.get(tree, node.id)?.parent
          // NEVER DEAD-END (owner E2): a stuck NON-root leaf under verifyGoal does not block its ancestors.
          // Best-effort-commit it and GROW a fix sibling on its parent — a FRESH node whose goal is "fix the
          // source", which reframes a weak model away from re-running the same broken binary (iter 26). The
          // parent/root goal-check is the real backstop; this only stops at the global step budget.
          if (deps.verifyGoal && parentID !== undefined && JhTree.size(tree) < maxTotalSteps) {
            tree = JhTree.setStatus(tree, node.id, "committed")
            // NOT a success: the leaf never passed its check — it is committed best-effort so the tree can
            // grow a fix sibling (below) rather than dead-end. Log it distinctly so reports/scripts can't
            // count it as a pass (R0 / D9 anatomy: run-32 read a best-effort commit as done).
            emit({ type: "committed_best_effort", step: node.id, reason: errorSig(vr.detail) })
            yield* growFixNode(parentID, node.draft.goal, vr.detail, node.draft.success ?? "the step's goal is met", "command" in check ? check.command : undefined)
            yield* bubble(node.id)
            yield* checkpoint()
            return
          }
          // improve17: THE ROOT NEVER DEAD-ENDS ON BUDGET EITHER. E2's never-dead-end law protected
          // every node except the root — which has no parent to grow a fix sibling on — so a root that
          // insists on one big atomic action (the model refusing to plan, even under mustDecompose)
          // exhausted its own attempts and BLOCKED THE WHOLE TASK ~2 minutes into a 40-minute wall
          // (wave-15 run11; wave-17 probe 12695, 13 calls). The root has ITSELF: `appendChild` makes it
          // an expanded phase whose fix CHILD carries the directive (the oracle's own next-step text),
          // and the root-completion gate then drives the rest exactly as for any other phase.
          const rootRescue = parentID === undefined && (deps.verifyGoal || deps.taskComplete) && JhTree.size(tree) < maxTotalSteps
          if (node.depth < maxDepth) {
            const outcome = yield* forceDecompose(node, "budget", rootRescue)
            if (outcome === "atomic") {
              emit({ type: "root_extended", step: node.id, reason: errorSig(vr.detail) })
              yield* growFixNode(node.id, node.draft.goal, vr.detail, node.draft.success ?? "the step's goal is met", "command" in check ? check.command : undefined)
            }
          } else {
            blockNode(node, "budget")
          }
          yield* checkpoint()
          return
        }

        // UNIFIED DIRECTIVE recovery (owner's "explore/run as long as needed"): the leaf is a bounded
        // free-form loop — each failure, the model picks the SINGLE next action (ANY tool) toward the
        // GOAL, freely ALTERNATING between fixing a file (write_file) and running a command (run) until the
        // step's check passes. This is the write→compile→fix loop with no backtracking and no tool-lock.
        const actionDesc = currentTool === "write_file" ? `write_file ${String(currentArgs.path ?? "?")}` : typeof currentArgs.command === "string" ? currentArgs.command : JSON.stringify(currentArgs).slice(0, 200)
        // improve5 P1c: when the workspace is numbered AND replace_lines is offered, steer surgical fixes to
        // COORDINATES (the reliable way for a weak model) over quoting a byte sequence it can't reproduce.
        const coordEdit = deps.numberedWorkspace !== false && deps.toolNames.includes("replace_lines")
        const editHint = coordEdit
          ? "use `replace_lines {path, first_line, last_line, new_content}` addressing the `N→` line numbers shown above (the RELIABLE way to change specific lines — you do NOT have to reproduce the old text), or `edit_file` only for a SHORT, unique, easy-to-quote string"
          : "make a SURGICAL `edit_file` on the SPECIFIC line(s) named in the error (a targeted old_string→new_string on the code shown above)"
        const recovery = [
          "The previous action did NOT achieve this step's goal yet:",
          `  action: ${currentTool} — ${actionDesc}`,
          `  result/error: ${vr.detail}`,
          "The working-directory files with their CURRENT contents are shown above. Emit exactly ONE atomic Step for the SINGLE next action that makes real progress toward the goal:",
          `- SOURCE-CODE error (a compile/runtime error in a file) → ${editHint}. Do NOT rewrite the whole file — \`write_file\` is ONLY for creating a file that does not exist yet.`,
          `- The program RAN but produced WRONG output (e.g. expected '3.14159', got '3.0') → ONE function's logic is buggy. Fix just that function (${coordEdit ? "`replace_lines` by coordinate, or `edit_file`" : "`edit_file`"}) — re-emitting the entire file discards code you already verified and silently reintroduces bugs. NOTE: after ANY source edit the compiled .exe is STALE — your very next steps must RECOMPILE (a \`run\` gcc step) and then re-run, before checking output again.`,
          "- An edit left the file WORSE and you cannot repair it → `git_revert` to roll the file back to the last verified state, then try a DIFFERENT edit.",
          "- The goal needs a file a COMMAND produces (e.g. the compiled .exe) → `run` that command (every gcc call needs the `set PATH=…/bin;%PATH% &&` prefix; the .exe lands in the working directory).",
          "- The command itself was wrong (missing PATH, wrong path/filename, bad shell syntax) → a corrected `run` command.",
          `Do NOT repeat the exact action that just failed, and do NOT rewrite the whole program — if re-running gave the same wrong result, change the SPECIFIC buggy code ${coordEdit ? "with `replace_lines`" : "with edit_file"}.`,
        ].join("\n")
        const recoverPlan = yield* thinkFor(node.id, "recover", recovery)
        const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { extraContext: withPlan(recoverPlan, recovery)! })))
        if (Exit.isSuccess(ex)) {
          const parsed = JhExpander.parseReply(ex.value, { fallbackGoal: goalOf(node.id) })
          if (parsed.ok && parsed.draft.size === "atomic" && JhStep.structuralIssues(parsed.draft).filter((i) => i.severity === "error").length === 0) {
            draft = parsed.draft
            currentTool = parsed.draft.tool ?? currentTool
            currentArgs = parsed.draft.args ?? currentArgs
            // adopt a corrected check (pi.exe→.\pi.exe) but NEVER downgrade the goal gate (run+Pi → weak)
            if (parsed.draft.check && checkRank(parsed.draft.check) >= checkRank(check)) check = parsed.draft.check
            tree = JhTree.fill(tree, node.id, stripSubsteps(parsed.draft))
            emit({ type: "introspected", step: node.id })
          }
        }
      }
    })

  // B–E — process one pending node.
  const processNode = (node: JhTree.Node): Effect.Effect<void> =>
    Effect.gen(function* () {
      const allowDecomposition = node.depth < maxDepth
      let draft: JhStep.StepDraft | undefined
      let reminder: string | undefined
      const maxAttempts = node.id === tree.root ? ROOT_INTROSPECT_ATTEMPTS : 2 // P2a: the root gets many more
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const notLast = attempt < maxAttempts - 1
        const mainPlan = yield* thinkFor(node.id, allowDecomposition ? "decompose" : "atomic")
        const ex = yield* Effect.exit(
          deps.introspect(buildPrompt(node.id, { allowDecomposition, mustDecompose: false, formatReminder: reminder, ...(withPlan(mainPlan) !== undefined ? { extraContext: withPlan(mainPlan)! } : {}) })),
        )
        if (!Exit.isSuccess(ex)) {
          if (notLast) {
            reminder = undefined
            continue
          }
          blockNode(node, "llm_unreachable")
          return
        }
        const parsed = JhExpander.parseReply(ex.value, { fallbackGoal: goalOf(node.id) })
        if (!parsed.ok) {
          emit({ type: "parse_failed", step: node.id, issue: parsed.issue })
          updateTelemetry(node.id, (t) => ({ ...t, parseFails: t.parseFails + 1 }))
          if (notLast) {
            // P2b: parsed.issue now carries the located hint (position + snippet + likely cause).
            reminder = `Your previous reply could not be parsed — ${parsed.issue}. Output exactly ONE \`\`\`json object; fix the specific problem above.`
            continue
          }
          yield* structuralFailRecover(node, "unparseable") // D11: recover, don't cascade-block
          return
        }
        const errs = JhStep.structuralIssues(parsed.draft).filter((i) => i.severity === "error")
        if (errs.length > 0) {
          emit({ type: "structural_rejected", step: node.id, codes: errs.map((e) => e.code) })
          if (notLast) {
            reminder = `Your step was malformed (${errs.map((e) => e.code).join(", ")}). Fix it and re-emit exactly one json object.`
            continue
          }
          yield* structuralFailRecover(node, "malformed_step") // D11: recover, don't cascade-block
          return
        }
        draft = parsed.draft
        break
      }
      if (!draft) return // blockNode already ran

      tree = JhTree.fill(tree, node.id, stripSubsteps(draft))
      emit({ type: "introspected", step: node.id })
      if (draft.research_needed) emit({ type: "research_flagged", step: node.id })

      if (draft.size === "needs_decomposition") {
        // P3c (I5): at the depth cap, a node that STILL wants to decompose is not hard-blocked — attempt the
        // goal ATOMICALLY instead (re-introspect forcing one action). Never-dead-end covers a bad reply.
        if (deps.lazyPlan !== false && node.depth >= maxDepth) {
          emit({ type: "depth_degraded", step: node.id })
          const ex2 = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { allowDecomposition: false, formatReminder: "You are at the MAXIMUM planning depth — emit exactly ONE atomic Step (a single tool call) that makes progress on this goal; do NOT decompose further." })))
          if (Exit.isSuccess(ex2)) {
            const parsed2 = JhExpander.parseReply(ex2.value, { fallbackGoal: goalOf(node.id) })
            if (parsed2.ok && parsed2.draft.size === "atomic" && JhStep.structuralIssues(parsed2.draft).filter((i) => i.severity === "error").length === 0) {
              tree = JhTree.fill(tree, node.id, stripSubsteps(parsed2.draft))
              emit({ type: "introspected", step: node.id })
              yield* atomicLoop(node, parsed2.draft)
              return
            }
          }
          yield* structuralFailRecover(node, "depth_degraded") // couldn't get a clean atomic step — recover, don't block
          return
        }
        yield* decompose(node, draft.substeps ?? [])
        return
      }

      // A top-level atomic claim is almost always the model under-decomposing the whole task — nudge it
      // (Strict-mode policy only).
      if (deps.forceRootDecompose && node.depth === 0 && node.depth < maxDepth && (yield* trySoftDecompose(node))) {
        yield* checkpoint()
        return
      }

      const measured = { cardinality: JhDataflow.cardinality(tree, node.id), density: 0 }
      if (JhBudget.shouldForceSplit(deps.trigger, measured) && node.depth < maxDepth) {
        // improve5 P3.2: under lazyPlan the closure-cardinality trigger no longer measures complexity (context
        // = disk, §5 law-5) and its threshold misfires (run82) — disarm it to ADVISORY-only by default.
        if (deps.noForceSplit !== false && deps.lazyPlan !== false) {
          emit({ type: "forced_split_advisory", step: node.id, cardinality: measured.cardinality, density: measured.density })
          // fall through to atomicLoop below — no forced decomposition
        } else {
          emit({ type: "forced_split", step: node.id, cardinality: measured.cardinality, density: measured.density })
          // improve5 P3.1: if the model won't split, DEGRADE to an atomic attempt (never dead-end) instead of cannot_split.
          const outcome = yield* forceDecompose(node, "cannot_split", true)
          if (outcome !== "atomic") {
            yield* checkpoint()
            return
          }
          emit({ type: "split_degraded", step: node.id })
          // fall through to atomicLoop(node, draft) below
        }
      }

      yield* atomicLoop(node, draft)
    })

  return Effect.gen(function* () {
    if (!resume) emit({ type: "task_started", goal: task.goal })
    let guard = 0
    for (;;) {
      // improve7 P1.3: the engine owns its wall — at exhaustion it exits through the NORMAL terminal path
      // (terminal best-restore included) instead of relying on the harness's hard race, which bypasses
      // finalization entirely (the race stays as an infra backstop at wallMs + grace).
      if (deps.budget && deps.budget.wallMs > 0 && deps.budget.now() - deps.budget.startedAt >= deps.budget.wallMs) {
        emit({ type: "task_blocked", reason: "wall_exhausted" })
        return yield* finalizeReport("blocked", "wall_exhausted")
      }
      // improve11 P1 (racing): a losing racer stops cooperatively — through the terminal best-restore.
      if (deps.aborted?.()) {
        emit({ type: "task_blocked", reason: "aborted" })
        return yield* finalizeReport("blocked", "aborted")
      }
      // improve9 P1b: the oracle-done short-circuit. A sample said the task IS complete — the oracle is
      // the completion authority (D4/E8); remaining tree nodes are scaffolding. RE-CHECK before
      // committing (the flag never bypasses the authority it delegates to); a disagreeing re-check
      // clears the flag and resumes normal flow.
      if (oracleDone && deps.taskComplete) {
        const tc = deps.taskComplete({ workspace: renderWorkspace(), lastOutput: lastRunOutput })
        if (tc.done) {
          tree = JhTree.setStatus(tree, tree.root, "committed")
          emit({ type: "oracle_done", step: tree.root })
          emit({ type: "committed", step: tree.root })
          emit({ type: "task_done" })
          return yield* finalizeReport("done")
        }
        oracleDone = false
      }
      if (++guard > (maxTotalSteps + 8) * 16) {
        emit({ type: "task_blocked", reason: "loop_guard" })
        return yield* finalizeReport("blocked", "loop_guard")
      }
      if (JhTree.size(tree) > maxTotalSteps) {
        emit({ type: "task_blocked", reason: "step_budget" })
        return yield* finalizeReport("blocked", "step_budget")
      }
      const node = JhTree.nextPending(tree)
      if (!node) {
        const root = JhTree.get(tree, tree.root)
        if (root && root.status === "committed") {
          emit({ type: "task_done" })
          return yield* finalizeReport("done")
        }
        // Root-completion goal verification + dynamic extend (owner #5 + #2): all children committed but
        // bubble deferred the root under verifyGoal. Verify the WHOLE-TASK goal against the workspace; if
        // the deliverable is NOT actually done (e.g. the program runs but prints wrong digits), EXTEND the
        // root with ONE fix node and keep going — never a false-done. Block only at the global step budget.
        if (root && (deps.verifyGoal || deps.taskComplete) && root.status === "expanded" && JhTree.allChildrenCommitted(tree, tree.root)) {
          // improve4 P2: cheap mechanical FIRST (the D2 ordering lesson) — re-run the regression suite before
          // the (expensive, precision-bounded) oracle/goal-check. A red foundation grows a fix node on the
          // root and re-loops; the oracle never even runs on a broken suite.
          if (phaseGateOn && (yield* runPhaseGate(tree.root))) continue
          // A precise task oracle (deps.taskComplete) is preferred — the LLM goal-check's precision is bounded
          // by the model's own knowledge (iter 31: it false-done'd a 50-of-100-correct Pi). Fall back to the
          // LLM goal-check when no oracle is provided.
          let verdict: { achieved: boolean; missing: string }
          let cachedMarker = ""
          if (deps.taskComplete) {
            const tc = deps.taskComplete({ workspace: renderWorkspace(), lastOutput: lastRunOutput })
            verdict = { achieved: tc.done, missing: tc.detail }
          } else {
            const res = yield* runGoalCheck(task.goal, true) // R2: cached + evidence-quoted (root whole-task LLM fallback)
            verdict = { achieved: res.achieved, missing: res.missing }
            if (res.cached) cachedMarker = " (cached — state unchanged)"
          }
          emit({ type: "verification", step: tree.root, ok: verdict.achieved, detail: (verdict.achieved ? "task goal achieved" : `task goal NOT achieved — ${verdict.missing}`) + cachedMarker })
          if (verdict.achieved) {
            tree = JhTree.setStatus(tree, tree.root, "committed")
            emit({ type: "committed", step: tree.root })
            emit({ type: "task_done" })
            return yield* finalizeReport("done")
          }
          if (JhTree.size(tree) < maxTotalSteps) {
            const beforeCount = JhTree.get(tree, tree.root)!.children.length
            yield* growFixNode(tree.root, task.goal, verdict.missing || "the deliverable is missing or incorrect", "the task's deliverable is produced and verified correct")
            if (JhTree.get(tree, tree.root)!.children.length > beforeCount) continue
          }
          emit({ type: "task_blocked", reason: "goal_unmet" })
          return yield* finalizeReport("blocked", "goal_unmet")
        }
        const reason = lastBlockReason ?? "no_progress"
        emit({ type: "task_blocked", reason })
        return yield* finalizeReport("blocked", reason)
      }
      yield* processNode(node)
    }
  })
}
