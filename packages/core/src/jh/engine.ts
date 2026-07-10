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
  /** R2 (jh-improve1): a goal-check that claims `achieved:true` must quote VERBATIM proof from the workspace
   *  or last output; an absent/unverifiable quote is treated as not-achieved (kills the rubber-stamp that
   *  false-done'd run31/32). Default ON. */
  readonly evidence?: boolean
  /** OPTIONAL precise task-completion oracle for root-completion. When the deliverable has an exact,
   *  machine-checkable success criterion (a known expected output), the caller injects it here — it is more
   *  reliable than the LLM goal-check, whose precision is bounded by the model's own knowledge (iter 31:
   *  qwen memorizes Pi to ~50 digits, so it false-done'd a 50-correct output). Given the workspace + last
   *  run stdout, returns whether the task is truly done and, if not, a coarse hint for the fix node. When
   *  absent, root-completion falls back to the LLM goal-check. The program still must COMPUTE the result;
   *  this only CHECKS it (a test oracle, not the model cheating). */
  readonly taskComplete?: (input: { readonly workspace: string; readonly lastOutput: string }) => { readonly done: boolean; readonly detail: string }
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
        const bodies = files.map((f) => `### ${f.name}\n\`\`\`\n${f.content.length > 8000 ? f.content.slice(0, 8000) + "\n…[truncated]…" : f.content}\n\`\`\``)
        fileBlock = `\n\n# Working directory (the ACTUAL files on disk — reference these exact names, and fix code here if a step failed)\n${bodies.join("\n\n")}`
      }
    }
    const full = `${base}${fileBlock}`
    return extra ? `${full}\n\n${extra}` : full
  }
  /** the current workspace (file names + contents) as a plain block — for the goal-achievement check. */
  const renderWorkspace = (): string => {
    const files = deps.listFiles?.() ?? []
    if (files.length === 0) return "(no files yet)"
    return files
      .map((f) => `### ${f.name}\n\`\`\`\n${f.content.length > 8000 ? f.content.slice(0, 8000) + "\n…[truncated]…" : f.content}\n\`\`\``)
      .join("\n\n")
  }
  // R2: run-scoped LLM goal-check cache + verdict result. `cached` lets the caller mark the transcript;
  // `evidenceFault` = an achieved:true claim without a verifiable verbatim quote (a checker fault, not a
  // model-action fault, so it must NOT accrue toward the leaf's stuck counter).
  const goalCheckCache = new Map<string, { achieved: boolean; missing: string; evidenceFault: boolean }>()
  interface GoalVerdict { readonly achieved: boolean; readonly missing: string; readonly cached: boolean; readonly evidenceFault: boolean }
  const runGoalCheck = (goal: string): Effect.Effect<GoalVerdict> =>
    Effect.gen(function* () {
      const workspace = renderWorkspace()
      const key = Hash.sha256(`${goal}|${workspace}|${lastRunOutput}`)
      if (deps.goalCheckCache !== false) {
        const hit = goalCheckCache.get(key)
        if (hit) return { ...hit, cached: true }
      }
      const gc = yield* Effect.exit(deps.introspect(JhExpander.goalCheckPrompt({ goal, workspace, lastOutput: lastRunOutput })))
      if (!Exit.isSuccess(gc)) return { achieved: true, missing: "", cached: false, evidenceFault: false } // unreachable checker → don't stall; accept
      const parsed = JhExpander.parseGoalCheck(gc.value)
      let verdict = { achieved: parsed.achieved, missing: parsed.missing, evidenceFault: false }
      // Evidence rule: a success claim must quote verbatim proof from the workspace or the last output.
      if (deps.evidence !== false && parsed.achieved) {
        const ev = (parsed.evidence ?? "").replace(/\s+/g, " ").trim()
        const material = `${workspace}\n${lastRunOutput}`.replace(/\s+/g, " ")
        if (ev.length === 0 || !material.includes(ev)) verdict = { achieved: false, missing: "goal-check claimed success without verifiable evidence", evidenceFault: true }
      }
      if (deps.goalCheckCache !== false) goalCheckCache.set(key, verdict)
      return { ...verdict, cached: false }
    })
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
    })
  }

  const bubble = (id: JhStep.StepID): void => {
    let childID: JhStep.StepID = id
    for (;;) {
      const child = JhTree.get(tree, childID)
      if (!child || child.parent === undefined) break
      const parentID = child.parent
      if (!JhTree.allChildrenCommitted(tree, parentID)) break
      // With a root gate on, the ROOT is not auto-committed here: the main loop runs a final whole-task
      // check first (and EXTENDS with a fix node if the deliverable isn't actually done).
      if ((deps.verifyGoal || deps.taskComplete) && parentID === tree.root) break
      tree = JhTree.setStatus(tree, parentID, "committed")
      emit({ type: "committed", step: parentID })
      childID = parentID
    }
  }
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
        const errors = JhDataflow.validate(current, deps.artifacts.ids()).filter((i) => i.code === "dangling_consumes")
        if (errors.length === 0) {
          const attached = JhTree.attach(tree, node.id, current, maxDepth)
          if (attached instanceof JhTree.AttachError) {
            blockNode(node, attached.reason === "max_depth" ? "depth_budget" : `attach_${attached.reason}`)
            return "blocked" as const
          }
          tree = attached
          emit({ type: "expanded", step: node.id, children: current.length })
          return "expanded" as const
        }
        emit({ type: "dataflow_rejected", step: node.id, issues: errors.map((e) => `${e.code}:${e.artifact}`) })
        if (attempt === 1) break
        const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { mustDecompose: true, formatReminder: JhExpander.dataflowRepairReminder(errors) })))
        if (!Exit.isSuccess(ex)) {
          blockNode(node, "llm_unreachable")
          return "blocked" as const
        }
        const parsed = JhExpander.parseReply(ex.value)
        if (!parsed.ok || !parsed.draft.substeps || parsed.draft.substeps.length === 0) {
          blockNode(node, "dataflow")
          return "blocked" as const
        }
        current = parsed.draft.substeps
      }
      blockNode(node, "dataflow")
      return "blocked" as const
    })

  // Re-introspect with mustDecompose (the force-split and budget-exhaustion paths). On a valid
  // decomposition it supersedes the leaf (the node becomes expanded); else it blocks with the given reason.
  const forceDecompose = (node: JhTree.Node, blockReasonIfAtomic: string): Effect.Effect<"expanded" | "blocked"> =>
    Effect.gen(function* () {
      const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { allowDecomposition: true, mustDecompose: true })))
      if (!Exit.isSuccess(ex)) {
        blockNode(node, "llm_unreachable")
        return "blocked" as const
      }
      const parsed = JhExpander.parseReply(ex.value)
      if (parsed.ok && parsed.draft.size === "needs_decomposition" && parsed.draft.substeps && parsed.draft.substeps.length > 0) {
        tree = JhTree.fill(tree, node.id, stripSubsteps(parsed.draft))
        emit({ type: "introspected", step: node.id })
        return yield* decompose(node, parsed.draft.substeps)
      }
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
        const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { allowDecomposition: true, mustDecompose: true })))
        if (!Exit.isSuccess(ex)) continue
        const parsed = JhExpander.parseReply(ex.value)
        const subs = parsed.ok && parsed.draft.size === "needs_decomposition" ? parsed.draft.substeps : undefined
        if (!subs || subs.length === 0) continue
        // Attach a structurally-valid plan REGARDLESS of declared dataflow: for file-based work the real
        // dependency is the file on disk (cwd), not the artifact store — a weak model's consumes/produces
        // ids are an unreliable proxy, and a dangling DECLARATION doesn't mean the step will fail (§9/§12).
        // Execution + the verify-gate are the real checks.
        const attached = JhTree.attach(tree, node.id, subs, maxDepth)
        if (attached instanceof JhTree.AttachError) continue
        tree = attached
        emit({ type: "introspected", step: node.id })
        emit({ type: "expanded", step: node.id, children: subs.length })
        return true
      }
      return false
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
        updateTelemetry(node.id, (t) => ({ ...t, attempts: t.attempts + 1 }))
        const before = snapFiles() // R1: workspace fingerprint BEFORE the action (source→product build graph)
        emit({ type: "action", step: node.id, tool: currentTool })
        const observation = yield* deps.executor.run({ tool: currentTool, args: currentArgs, produces: draft.produces ?? [], cwd: deps.cwd })
        if (currentTool === "run" && observation.ok) lastRunOutput = observation.output // remember the program's stdout for the goal-checks
        emit({ type: "observation", step: node.id, ok: observation.ok })
        if (staleness)
          staleness.recordAction({ tool: currentTool, ok: observation.ok, command: typeof currentArgs.command === "string" ? currentArgs.command : undefined, before, after: snapFiles() })

        // A STALE-artifact bookkeeping fail must NOT feed the stuck counter (it asks for a recompile, it is
        // not a model rut). Set only when a check ran a product whose sources changed but had no rebuild.
        let noCountSig = false
        let vr: JhVerifier.VerifyResult
        if (observation.ok) {
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
            for (const sp of staleness.allStale(curSnap)) {
              if (sp.rebuild === checkCommand) continue // the check itself (re)builds this product — don't pre-run it
              if (sp.rebuild) {
                emit({ type: "refreshed", step: node.id, command: sp.rebuild })
                const rb = yield* deps.runner.run({ command: sp.rebuild, cwd: deps.cwd, timeoutMs: JhVerifier.DEFAULT_TIMEOUT_MS })
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
            vr = yield* JhVerifier.verify({ check, cwd: deps.cwd, runner: deps.runner, fileExists: (rel) => deps.fileExists(rel, deps.cwd), producedPresent })
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
          const res = yield* runGoalCheck(goalOf(node.id)) // R2: cached + evidence-quoted
          const marker = res.cached ? " (cached — state unchanged)" : ""
          if (!res.achieved) {
            vr = { ok: false, detail: (res.evidenceFault ? "goal-check claimed success without verifiable evidence" : `goal not yet achieved — ${res.missing || "the deliverable is not produced/verified"}`) + marker }
            // an evidence fault is a CHECKER fault, not a model-action rut — it must not accrue toward stuck.
            if (res.evidenceFault) noCountSig = true
          } else if (res.cached) {
            vr = { ok: true, detail: "goal achieved" + marker } // surface the cache hit (no LLM call spent)
          }
        }
        emit({ type: "verification", step: node.id, ok: vr.ok, detail: vr.detail })

        if (vr.ok) {
          for (const p of draft.produces ?? []) {
            const content = observation.artifacts.get(p.id)
            if (content !== undefined) deps.artifacts.put(p, content)
          }
          tree = JhTree.setStatus(tree, node.id, "committed")
          emit({ type: "committed", step: node.id })
          bubble(node.id)
          yield* checkpoint()
          return
        }

        updateTelemetry(node.id, (t) => ({ ...t, verifierFails: t.verifierFails + 1 }))
        // Past the budget, keep exploring while the error keeps CHANGING (real progress) and under the cap.
        // "stuck" = the SAME error signature seen STUCK_REPEATS times (afpro changing-vs-stuck) — NOT merely a
        // 2nd occurrence: a weak model that repeats one mistake once (e.g. a PATH-less gcc) still deserves a
        // few more shots; temperature variance breaks the loop (iters 23–24 blocked after just 2 repeats).
        const sig = errorSig(vr.detail)
        // A STALE-artifact bookkeeping fail (noCountSig) never accrues toward "stuck" — it is not a model rut,
        // just a signal to recompile (which the next step does). Everything else counts (incl. idempotence).
        let seen = errorCounts.get(sig) ?? 0
        if (!noCountSig) {
          seen += 1
          errorCounts.set(sig, seen)
        }
        const stuck = seen >= STUCK_REPEATS
        const attempts = telemetryOf(node.id).attempts
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
            const fixDraft: JhStep.StepDraft = {
              goal: fixNodeGoal(node.draft.goal, errorSig(vr.detail), JhTree.get(tree, parentID)!.children.length),
              size: "atomic",
              success: node.draft.success ?? "the step's goal is met",
            }
            const appended = JhTree.appendChild(tree, parentID, fixDraft, maxDepth)
            if (!(appended instanceof JhTree.AttachError)) {
              tree = appended
              emit({ type: "expanded", step: parentID, children: JhTree.get(tree, parentID)!.children.length })
            }
            bubble(node.id)
            yield* checkpoint()
            return
          }
          if (node.depth < maxDepth) {
            yield* forceDecompose(node, "budget")
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
        const recovery = [
          "The previous action did NOT achieve this step's goal yet:",
          `  action: ${currentTool} — ${actionDesc}`,
          `  result/error: ${vr.detail}`,
          "The working-directory files with their CURRENT contents are shown above. Emit exactly ONE atomic Step for the SINGLE next action that makes real progress toward the goal:",
          "- SOURCE-CODE error (a compile/runtime error in a file) → write_file with the COMPLETE corrected source (edit the code shown above).",
          "- The program RAN but produced WRONG output (e.g. expected '3.14159', got '3.0') → the SOURCE ALGORITHM is buggy. write_file the corrected source (fix the logic in the code above). NOTE: after ANY source edit the compiled .exe is STALE — your very next steps must RECOMPILE (a `run` gcc step) and then re-run, before checking output again.",
          "- The goal needs a file a COMMAND produces (e.g. the compiled .exe) → `run` that command (every gcc call needs the `set PATH=…/bin;%PATH% &&` prefix; the .exe lands in the working directory).",
          "- The command itself was wrong (missing PATH, wrong path/filename, bad shell syntax) → a corrected `run` command.",
          "Do NOT repeat the exact action that just failed — if re-running gave the same wrong result, the SOURCE must change.",
        ].join("\n")
        const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { extraContext: recovery })))
        if (Exit.isSuccess(ex)) {
          const parsed = JhExpander.parseReply(ex.value)
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
      for (let attempt = 0; attempt < 2; attempt++) {
        const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { allowDecomposition, mustDecompose: false, formatReminder: reminder })))
        if (!Exit.isSuccess(ex)) {
          if (attempt === 0) {
            reminder = undefined
            continue
          }
          blockNode(node, "llm_unreachable")
          return
        }
        const parsed = JhExpander.parseReply(ex.value)
        if (!parsed.ok) {
          emit({ type: "parse_failed", step: node.id, issue: parsed.issue })
          updateTelemetry(node.id, (t) => ({ ...t, parseFails: t.parseFails + 1 }))
          if (attempt === 0) {
            reminder = `Your previous reply could not be parsed (${parsed.issue}). Output exactly ONE \`\`\`json object.`
            continue
          }
          blockNode(node, "unparseable")
          return
        }
        const errs = JhStep.structuralIssues(parsed.draft).filter((i) => i.severity === "error")
        if (errs.length > 0) {
          emit({ type: "structural_rejected", step: node.id, codes: errs.map((e) => e.code) })
          if (attempt === 0) {
            reminder = `Your step was malformed (${errs.map((e) => e.code).join(", ")}). Fix it and re-emit exactly one json object.`
            continue
          }
          blockNode(node, "malformed_step")
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
        emit({ type: "forced_split", step: node.id, cardinality: measured.cardinality, density: measured.density })
        yield* forceDecompose(node, "cannot_split")
        yield* checkpoint()
        return
      }

      yield* atomicLoop(node, draft)
    })

  return Effect.gen(function* () {
    if (!resume) emit({ type: "task_started", goal: task.goal })
    let guard = 0
    for (;;) {
      if (++guard > (maxTotalSteps + 8) * 16) {
        emit({ type: "task_blocked", reason: "loop_guard" })
        return report("blocked", "loop_guard")
      }
      if (JhTree.size(tree) > maxTotalSteps) {
        emit({ type: "task_blocked", reason: "step_budget" })
        return report("blocked", "step_budget")
      }
      const node = JhTree.nextPending(tree)
      if (!node) {
        const root = JhTree.get(tree, tree.root)
        if (root && root.status === "committed") {
          emit({ type: "task_done" })
          return report("done")
        }
        // Root-completion goal verification + dynamic extend (owner #5 + #2): all children committed but
        // bubble deferred the root under verifyGoal. Verify the WHOLE-TASK goal against the workspace; if
        // the deliverable is NOT actually done (e.g. the program runs but prints wrong digits), EXTEND the
        // root with ONE fix node and keep going — never a false-done. Block only at the global step budget.
        if (root && (deps.verifyGoal || deps.taskComplete) && root.status === "expanded" && JhTree.allChildrenCommitted(tree, tree.root)) {
          // A precise task oracle (deps.taskComplete) is preferred — the LLM goal-check's precision is bounded
          // by the model's own knowledge (iter 31: it false-done'd a 50-of-100-correct Pi). Fall back to the
          // LLM goal-check when no oracle is provided.
          let verdict: { achieved: boolean; missing: string }
          let cachedMarker = ""
          if (deps.taskComplete) {
            const tc = deps.taskComplete({ workspace: renderWorkspace(), lastOutput: lastRunOutput })
            verdict = { achieved: tc.done, missing: tc.detail }
          } else {
            const res = yield* runGoalCheck(task.goal) // R2: cached + evidence-quoted LLM fallback
            verdict = { achieved: res.achieved, missing: res.missing }
            if (res.cached) cachedMarker = " (cached — state unchanged)"
          }
          emit({ type: "verification", step: tree.root, ok: verdict.achieved, detail: (verdict.achieved ? "task goal achieved" : `task goal NOT achieved — ${verdict.missing}`) + cachedMarker })
          if (verdict.achieved) {
            tree = JhTree.setStatus(tree, tree.root, "committed")
            emit({ type: "committed", step: tree.root })
            emit({ type: "task_done" })
            return report("done")
          }
          if (JhTree.size(tree) < maxTotalSteps) {
            const fixDraft: JhStep.StepDraft = {
              goal: fixNodeGoal(task.goal, verdict.missing || "the deliverable is missing or incorrect", root.children.length),
              size: "atomic",
              success: "the task's deliverable is produced and verified correct",
            }
            const appended = JhTree.appendChild(tree, tree.root, fixDraft, maxDepth)
            if (!(appended instanceof JhTree.AttachError)) {
              tree = appended
              emit({ type: "expanded", step: tree.root, children: JhTree.get(tree, tree.root)!.children.length })
              continue
            }
          }
          emit({ type: "task_blocked", reason: "goal_unmet" })
          return report("blocked", "goal_unmet")
        }
        const reason = lastBlockReason ?? "no_progress"
        emit({ type: "task_blocked", reason })
        return report("blocked", reason)
      }
      yield* processNode(node)
    }
  })
}
