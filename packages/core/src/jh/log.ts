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
  // R3: on escalation + regression, the best-scoring workspace snapshot was restored to disk.
  | { readonly type: "restored_best"; readonly step: string; readonly score: number }
  // R4: a rewrite-stage fix node produced no source change — the directive was ignored.
  | { readonly type: "directive_ignored"; readonly step: string }
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
      return `restored_best ${e.step}: score=${e.score}`
    case "directive_ignored":
      return `directive_ignored ${e.step}`
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
