export * as ConfigStrict from "./strict"

import { Schema } from "effect"

// Strict mode (the Juvenile Harness posture, jh.md) — the weak-/local-model execution discipline: the
// harness owns decomposition, per-step compile/test verification, external correction, and recovery, so
// a small model is never asked to hold the whole horizon (taxonomy E6: every JH option user-surfaced).
// This config is the CONTRACT the harness reads; the session-runner integration (P14) resolves it per
// session, and the jh batch harnesses consume the same groups today via their JH_* env mapping:
//   verification  → staleness / regressionGate / phaseGate (the build-graph + persistent-suite gates)
//   recovery      → keepBest / restoreOnDrop / autoRevert / ladder / rederive (never walk away from the best state)
//   editingAids   → numberedWorkspace / fullFiles / txEdits / coordMode (surgical-edit reliability)
//   budgetSteering→ budgetAware (wall-clock steers at 50%/75%)
export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Run Strict-harness sessions: decomposition + per-step verification for weak/local models (default: false)",
  }),
  verification: Schema.optional(Schema.Boolean).annotate({
    description: "Verification gates: derived-artifact staleness tracking + the persistent regression suite + phase gate (default: true)",
  }),
  recovery: Schema.optional(Schema.Boolean).annotate({
    description: "Recovery: keep-best snapshots (incl. restore-on-drop + terminal restore), harness-owned auto-revert, the escalation ladder, component re-derive (default: true)",
  }),
  editingAids: Schema.optional(Schema.Boolean).annotate({
    description: "Editing aids: numbered full-visibility workspace, transactional edit gate, coordinate-edit enforcement after repeated mis-quotes (default: true)",
  }),
  budgetSteering: Schema.optional(Schema.Boolean).annotate({
    description: "Wall-clock awareness: calm simplify/land-it steers at 50%/75% of the time budget (default: true)",
  }),
  wallMinutes: Schema.optional(Schema.Number).annotate({
    description: "Wall-clock budget per Strict task in minutes; the engine stops through its terminal best-restore at exhaustion (default: 45)",
  }),
  attempts: Schema.optional(Schema.Number).annotate({
    description:
      "Best-of-N racing (jh.md §14.2): run N isolated attempts on FORKED copies of the workspace and keep the first verified winner (1 = off, max 8). Explicit opt-in — costs ~N× compute; the Spark's bandwidth-bound decoding makes concurrent attempts nearly free capacity (default: 1)",
  }),
  // The two per-call token budgets (owner, 2026-07-16). These bound GENERATION, not context: a local
  // model is typically served with a 128k context, but each call still needs room to FINISH. They are
  // separate knobs because the two step kinds fail in opposite ways when starved.
  executionTokens: Schema.optional(Schema.Number).annotate({
    description:
      "Token budget for EXECUTION steps — the calls that fill in the step schema and write files. Truncation is fatal here (jh.md §3: a non-trivial C source file is ~13-15k tokens), so leave headroom (default: 24576)",
  }),
  reasoningTokens: Schema.optional(Schema.Number).annotate({
    description:
      "Token budget for the REASONING stage that plans a step before it runs — 0 disables the stage (notes/jh-think-stage.md). MEASURED on qwen3.6-35b: a reasoning model cut off mid-thought returns EMPTY, because the close of its <think> block never arrives and the parser has nothing to extract — 3072 and 8192 both yield nothing, 24576 completes (18974 tokens used). Budget it generously or not at all: an empty finish=length reply is a BUDGET reading, never a capability reading (default: 0 = off)",
  }),
})
export type Info = typeof Info.Type
