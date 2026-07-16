export * as JhLog from "./log"

// jh — the engine-internal append-only event log (jh.md §6b: Intent · Action · Observation ·
// Verification, where everything after Intent is machine-generated). Engine-internal only — it does NOT
// ride EventV2 (D10). Each entry is stamped with a monotonic seq by the engine; `render` gives a
// one-line-per-entry transcript for smokes and reports.

export type Entry =
  | { readonly type: "task_started"; readonly goal: string }
  | { readonly type: "introspected"; readonly step: string }
  | { readonly type: "parse_failed"; readonly step: string; readonly issue: string }
  | { readonly type: "structural_rejected"; readonly step: string; readonly codes: ReadonlyArray<string> }
  | { readonly type: "dataflow_rejected"; readonly step: string; readonly issues: ReadonlyArray<string> }
  | { readonly type: "expanded"; readonly step: string; readonly children: number }
  | { readonly type: "forced_split"; readonly step: string; readonly cardinality: number; readonly density: number }
  | { readonly type: "research_flagged"; readonly step: string }
  | { readonly type: "action"; readonly step: string; readonly tool: string }
  // R1 staleness: a check would have run a STALE product, so the harness auto-re-ran the model's own last
  // successful producing command (the make discipline) before verifying — deterministic bookkeeping.
  | { readonly type: "refreshed"; readonly step: string; readonly command: string }
  | { readonly type: "observation"; readonly step: string; readonly ok: boolean }
  | { readonly type: "verification"; readonly step: string; readonly ok: boolean; readonly detail: string }
  | { readonly type: "corrected"; readonly step: string }
  // R3: a new best progress score was observed (graded oracle).
  | { readonly type: "scored"; readonly step: string; readonly score: number }
  // R3: on a score regression, the best-scoring workspace snapshot was restored to disk. improve7 P1 (K5)
  // widened the trigger beyond escalation: `drop` = consecutive below-best samples mid-run; `final` = the
  // terminal restore (the deliverable is the BEST state, never a regressed one — run112 walked away from 82
  // digits; run113 from 98).
  | { readonly type: "restored_best"; readonly step: string; readonly score: number; readonly reason: "escalation" | "drop" | "final" }
  // improve7 P2 (C7): a file crossed COORD_AFTER consecutive `old_string not found` misses — edit_file is
  // disabled for it (intercepted pre-execution with a replace_lines redirect) until a successful edit lands.
  | { readonly type: "coord_mode"; readonly step: string; readonly file: string }
  // R4: a rewrite-stage fix node produced no source change — the directive was ignored.
  | { readonly type: "directive_ignored"; readonly step: string }
  // improve3 P1: N consecutive build-damaging edits → the harness auto-reverted to the last verified checkpoint.
  | { readonly type: "reverted"; readonly step: string; readonly reason: string }
  // improve3 P3b: lazy planning stripped nested sub-substeps from a decomposition (attach top level only).
  | { readonly type: "flattened"; readonly step: string; readonly discarded: number }
  // improve3 P3c: a node at maxDepth still wanted to decompose — run it atomically instead of hard-blocking.
  | { readonly type: "depth_degraded"; readonly step: string }
  // improve4 P1: a passing run/output_equals check that executes a workspace product was REGISTERED as a
  // persistent regression test (first registration only).
  | { readonly type: "test_registered"; readonly step: string; readonly command: string }
  // improve4 P1: a registered test that passed before the edit FAILS now — the source-edit at `step` broke
  // previously-verified behavior; `changed` names the file(s) the edit touched. Preempts the leaf's own check.
  | { readonly type: "regression"; readonly step: string; readonly command: string; readonly changed: ReadonlyArray<string> }
  // improve4 P1/P2: a regression-suite evaluation (a post-edit re-run or a phase/root gate). `skipped` > 0
  // means the MAX_SUITE_MS budget cut it short — surfaced so a partial suite is never silently trusted.
  | { readonly type: "suite"; readonly step: string; readonly green: number; readonly red: number; readonly skipped: number }
  // improve4 P4: a component that kept failing its test was targeted for a from-scratch re-derivation.
  | { readonly type: "rederived"; readonly step: string; readonly file: string }
  // improve5 P2: a source edit was REJECTED at the door — it did not compile (its per-file syntax gate
  // failed) and the file was restored to its pre-image; the workspace never went un-green.
  | { readonly type: "edit_rejected"; readonly step: string; readonly file: string }
  // improve6 P1: after GATE_YIELD_AFTER consecutive rejections of the same file, the gate YIELDS — the next
  // attempt lands regardless, restoring iteration-with-visibility (one-shot-perfect must be impossible;
  // wave-5 runs 102/104 were locked 73-123× behind the gate). The normal rebuild/regression loop takes over.
  | { readonly type: "gate_yielded"; readonly step: string; readonly file: string }
  // improve6 P3: a registered test was marked SUSPECT (its own file doesn't build, or it stays red while the
  // program's measured output improves) — it loses its veto and a one-time test-fix node is grown (run101
  // died 29× on a t_arctan whose expectation was mathematically impossible; tests are code too).
  | { readonly type: "suspect_test"; readonly step: string; readonly command: string }
  // improve6 P5: the numeric-divergence signature fired (score plateau with a green build) — the caller's
  // numerics hint was injected into the NEXT introspection context (never the planning prompt).
  | { readonly type: "numerics_hint"; readonly step: string }
  // improve9 P1a: a sample scored ≥ NEAR_DONE with the oracle NOT done — the oracle's own verdict was
  // delivered to the NEXT introspection (run136 held "fix the PRINTING" for ~370 events unseen).
  | { readonly type: "oracle_hint"; readonly step: string }
  // improve9 P1b: a sample reported the task COMPLETE; the main loop re-checked the oracle and
  // short-circuited to done — remaining tree nodes were scaffolding.
  | { readonly type: "oracle_done"; readonly step: string }
  // improve10 P1 (§K6): an UNREGISTERED test failed byte-identically across distinct source states —
  // oracle-suspect; a re-derive-the-TEST sibling was grown (the never-green registration hole closed).
  | { readonly type: "test_never_green"; readonly step: string; readonly command: string }
  // improve5 P3: a forced_split whose node could NOT be decomposed degraded to an ATOMIC attempt instead of
  // hard-blocking (cannot_split) — the never-dead-end invariant, finally uniform.
  | { readonly type: "split_degraded"; readonly step: string }
  // improve5 (root-hardening): the ROOT could not be planned (a malformed multi-step reply, 10 retries) —
  // instead of the E7 hard-block, it degraded to a single atomic START step + the exploration loop.
  | { readonly type: "root_degraded"; readonly step: string }
  // improve19 — the THINK/DO split. The plan is an ARTIFACT, not a hidden `<think>` channel: it is
  // logged verbatim so a run's reasoning is auditable (jh's legibility value; the product's "show me
  // why it did that"). `think_failed` records the improve1 ghost being caught by the fall-through.
  | { readonly type: "planned"; readonly step: string; readonly kind: string; readonly plan: string }
  | { readonly type: "think_failed"; readonly step: string; readonly reason: string }
  | { readonly type: "root_extended"; readonly step: string; readonly reason: string }
  // improve5 P3: the closure-cardinality force-split trigger fired but is DISARMED in the file-workspace
  // regime (context = disk, §5 law-5) — logged as advisory data for a future §4 recalibration, no behavior.
  | { readonly type: "forced_split_advisory"; readonly step: string; readonly cardinality: number; readonly density: number }
  // improve5 P4: a wall-clock budget threshold (0.5 / 0.75) was crossed → a calm "simplify / land it" steer
  // was injected into the next introspection (one-shot per threshold).
  | { readonly type: "budget_note"; readonly step: string; readonly fraction: number }
  | { readonly type: "committed"; readonly step: string }
  // A leaf the harness gave up VERIFYING (stuck/budget) but committed best-effort so the tree can grow a
  // fix sibling instead of dead-ending (engine.ts stuck path). NOT a success — the reason carries the
  // failing check's signature. Distinct from `committed` so transcripts/scripts can't mistake it for a pass.
  | { readonly type: "committed_best_effort"; readonly step: string; readonly reason: string }
  | { readonly type: "blocked"; readonly step: string; readonly reason: string }
  | { readonly type: "task_done" }
  | { readonly type: "task_blocked"; readonly reason: string }

export type Sequenced = Entry & { readonly seq: number }

function describe(e: Sequenced): string {
  switch (e.type) {
    case "task_started":
      return `task_started: ${e.goal}`
    case "introspected":
      return `introspected ${e.step}`
    case "parse_failed":
      return `parse_failed ${e.step}: ${e.issue}`
    case "structural_rejected":
      return `structural_rejected ${e.step}: ${e.codes.join(", ")}`
    case "dataflow_rejected":
      return `dataflow_rejected ${e.step}: ${e.issues.join(", ")}`
    case "expanded":
      return `expanded ${e.step} → ${e.children} children`
    case "forced_split":
      return `forced_split ${e.step} (cardinality ${e.cardinality}, density ${e.density})`
    case "research_flagged":
      return `research_flagged ${e.step}`
    case "action":
      return `action ${e.step}: ${e.tool}`
    case "refreshed":
      return `refreshed ${e.step}: re-ran \`${e.command}\` (stale product)`
    case "observation":
      return `observation ${e.step}: ${e.ok ? "ok" : "fail"}`
    case "verification":
      return `verification ${e.step}: ${e.ok ? "pass" : "fail"}${e.detail ? ` — ${e.detail}` : ""}`
    case "corrected":
      return `corrected ${e.step}`
    case "scored":
      return `scored ${e.step}: best=${e.score}`
    case "restored_best":
      return `restored_best ${e.step}: score=${e.score} (${e.reason})`
    case "coord_mode":
      return `coord_mode ${e.step}: ${e.file} — edit_file disabled after repeated mis-quotes; use replace_lines coordinates`
    case "directive_ignored":
      return `directive_ignored ${e.step}`
    case "reverted":
      return `reverted ${e.step}: ${e.reason}`
    case "flattened":
      return `flattened ${e.step} (discarded ${e.discarded} nested)`
    case "depth_degraded":
      return `depth_degraded ${e.step} (ran atomic at the cap)`
    case "test_registered":
      return `test_registered ${e.step}: \`${e.command}\``
    case "gate_yielded":
      return `gate_yielded ${e.step}: ${e.file} — the edit gate yields after repeated rejections; the next attempt lands`
    case "suspect_test":
      return `suspect_test ${e.step}: \`${e.command}\` — excluded from gating (the test itself may be wrong)`
    case "numerics_hint":
      return `numerics_hint ${e.step}: score plateau with a green build — numerics guidance injected`
    case "oracle_hint":
      return `oracle_hint ${e.step}: near-done — the oracle's verdict delivered to the next introspection`
    case "oracle_done":
      return `oracle_done ${e.step}: the oracle reports the task complete — short-circuiting to done`
    case "test_never_green":
      return `test_never_green ${e.step}: \`${e.command}\` failed identically across changing source — re-derive the TEST`
    case "regression":
      return `REGRESSION ${e.step}: \`${e.command}\` broke after editing ${e.changed.join(", ") || "the workspace"}`
    case "suite":
      return `suite ${e.step}: ${e.green} green, ${e.red} red${e.skipped > 0 ? `, ${e.skipped} skipped (budget)` : ""}`
    case "rederived":
      return `rederived ${e.step}: fresh implementation of ${e.file}`
    case "edit_rejected":
      return `edit_rejected ${e.step}: ${e.file} did not compile — reverted (workspace stays green)`
    case "split_degraded":
      return `split_degraded ${e.step} (could not split — ran atomic instead of blocking)`
    case "root_degraded":
      return `root_degraded ${e.step} (could not plan — degraded to a single atomic start, never dead-ended)`
    case "planned":
      return `planned ${e.step} (${e.kind}): ${e.plan.replace(/\n/g, " | ")}`
    case "think_failed":
      return `think_failed ${e.step} — ${e.reason} (falling through to the unplanned path)`
    case "root_extended":
      return `root_extended ${e.step} — ${e.reason} (the root exhausted its own attempts and refuses to plan; growing a fix CHILD under it instead of dead-ending)`
    case "forced_split_advisory":
      return `forced_split_advisory ${e.step} (cardinality ${e.cardinality}, density ${e.density} — disarmed)`
    case "budget_note":
      return `budget_note ${e.step}: ${Math.round(e.fraction * 100)}% of the time budget consumed`
    case "committed":
      return `committed ${e.step}`
    case "committed_best_effort":
      return `committed(best-effort) ${e.step} — ${e.reason}`
    case "blocked":
      return `blocked ${e.step}: ${e.reason}`
    case "task_done":
      return "task_done"
    case "task_blocked":
      return `task_blocked: ${e.reason}`
  }
}

export function render(log: ReadonlyArray<Sequenced>): string {
  return log.map((e) => `[${e.seq}] ${describe(e)}`).join("\n")
}
