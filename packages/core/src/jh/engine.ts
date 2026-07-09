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
import { JhTree } from "./tree"
import { JhStep } from "./step"
import { JhDataflow } from "./dataflow"
import { JhContext } from "./context"
import { JhBudget } from "./budget"
import { JhVerifier } from "./verifier"
import { JhExpander } from "./expander"
import { JhCorrector } from "./corrector"
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
const EXPLORE_CAP = 6
// The root soft-decompose retries this many times: a weak model insists atomic on some draws but yields a
// proper plan on others (temperature variance), so a couple of retries reliably gets a decomposition.
const SOFT_DECOMPOSE_ATTEMPTS = 3
const errorSig = (detail: string): string => detail.slice(0, 160).trim()

export function runTask(deps: Deps, task: { readonly goal: string }, resume?: State): Effect.Effect<Report> {
  const { maxDepth, maxTotalSteps } = deps.limits

  // ---- mutable engine state (closed over by every helper below) ----
  let tree: JhTree.Tree = resume?.tree ?? JhTree.create({ goal: task.goal, size: "atomic", success: "the task is complete" })
  const telemetry = new Map<string, JhBudget.Telemetry>(resume?.telemetry ?? [])
  const logArr: JhLog.Sequenced[] = [...(resume?.log ?? [])]
  let seq = logArr.length
  let lastBlockReason: string | undefined

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
      const check: JhStep.Check = draft.check ?? { type: "artifact_present" }
      // Budget is seeded by the prior and fixed for this leaf (telemetry is recorded but does not
      // self-escalate the budget mid-leaf — else a trivial-prior leaf could never exhaust; see ledger).
      const budget = JhBudget.budgetFor(draft.difficulty_prior ?? undefined, JhBudget.emptyTelemetry)
      const seenErrors = new Set<string>() // distinct verify-failure signatures seen for THIS leaf
      for (;;) {
        updateTelemetry(node.id, (t) => ({ ...t, attempts: t.attempts + 1 }))
        emit({ type: "action", step: node.id, tool: currentTool })
        const observation = yield* deps.executor.run({ tool: currentTool, args: currentArgs, produces: draft.produces ?? [], cwd: deps.cwd })
        emit({ type: "observation", step: node.id, ok: observation.ok })

        let vr: JhVerifier.VerifyResult
        if (observation.ok) {
          const producedPresent = (draft.produces ?? []).every((p) => {
            const c = observation.artifacts.get(p.id)
            return c !== undefined && c.length > 0
          })
          vr = yield* JhVerifier.verify({ check, cwd: deps.cwd, runner: deps.runner, fileExists: (rel) => deps.fileExists(rel, deps.cwd), producedPresent })
        } else {
          vr = { ok: false, detail: observation.output }
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
        // Past the budget, keep exploring only while errors stay NOVEL and under the cap; a repeated error
        // (stuck) or the cap ends the leaf.
        const sig = errorSig(vr.detail)
        const stuck = sig === "" || seenErrors.has(sig)
        seenErrors.add(sig)
        const attempts = telemetryOf(node.id).attempts
        if (attempts > budget && (stuck || attempts >= EXPLORE_CAP)) {
          if (node.depth < maxDepth) {
            yield* forceDecompose(node, "budget")
          } else {
            blockNode(node, "budget")
          }
          yield* checkpoint()
          return
        }

        if (currentTool === "write_file") {
          const produces = draft.produces ?? []
          const firstProduce = produces.find((p) => p.type === "file") ?? produces[0]
          updateTelemetry(node.id, (t) => ({ ...t, correctorCalls: t.correctorCalls + 1 }))
          const cex = yield* Effect.exit(
            deps.correct(JhCorrector.correctorPrompt({ goal: draft.goal, artifactID: firstProduce?.id ?? "output", artifactContent: String(currentArgs.content ?? ""), error: vr.detail })),
          )
          if (Exit.isSuccess(cex)) {
            const pc = JhCorrector.parseCorrection(cex.value)
            if (pc.ok) {
              currentArgs = { ...currentArgs, content: pc.content }
              emit({ type: "corrected", step: node.id })
            }
          }
        } else {
          const ex = yield* Effect.exit(deps.introspect(buildPrompt(node.id, { extraContext: `### previous attempt failed\n${vr.detail}` })))
          if (Exit.isSuccess(ex)) {
            const parsed = JhExpander.parseReply(ex.value)
            if (parsed.ok && parsed.draft.size === "atomic" && JhStep.structuralIssues(parsed.draft).filter((i) => i.severity === "error").length === 0) {
              draft = parsed.draft
              currentTool = parsed.draft.tool ?? currentTool
              currentArgs = parsed.draft.args ?? currentArgs
              tree = JhTree.fill(tree, node.id, stripSubsteps(parsed.draft))
              emit({ type: "introspected", step: node.id })
            }
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
        const reason = lastBlockReason ?? "no_progress"
        emit({ type: "task_blocked", reason })
        return report("blocked", reason)
      }
      yield* processNode(node)
    }
  })
}
