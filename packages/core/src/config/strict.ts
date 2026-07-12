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
})
export type Info = typeof Info.Type
