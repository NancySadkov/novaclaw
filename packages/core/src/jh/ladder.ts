export * as JhLadder from "./ladder"

// jh — the escalation ladder (jh-improve1 R4 / defects D3, D6, D7). Replaces the latching ESCALATE_AFTER
// counter: escalation state is PER-PROBLEM-SIGNATURE and RESETS on any score improvement or signature change,
// and the ladder CYCLES rather than latching — tweak ×N → analyze → targeted_fix → (once) rewrite → back to
// tweak, cycling tweak→analyze→targeted_fix indefinitely thereafter (a rewrite is drastic, spent once per
// run). Pure + deterministic; the engine holds one LadderState per parent and reads `stage` to pick the fix
// directive. Engine-run-scoped, in-memory (L4).

export type Stage = "tweak" | "analyze" | "targeted_fix" | "rewrite"

export interface LadderState {
  readonly sig: string // the failing-detail signature this escalation is tracking
  readonly count: number // consecutive escalations on this same sig
  readonly stage: Stage // the directive tier to apply now
  readonly rewrites: number // how many rewrites have been spent this run (rewrite fires only while 0)
}

export function next(
  prev: LadderState | undefined,
  input: { readonly sig: string; readonly scoreImproved: boolean },
): LadderState {
  const { sig, scoreImproved } = input
  // A new problem, a changed signature, or real progress → reset to a fresh tweak (rewrites carry: a rewrite
  // is spent once per RUN, so a new problem does not re-earn one).
  if (!prev || prev.sig !== sig || scoreImproved) {
    return { sig, count: 1, stage: "tweak", rewrites: prev?.rewrites ?? 0 }
  }
  // The previous step WAS a rewrite → it just ran; reset to tweak and mark the rewrite spent.
  if (prev.stage === "rewrite") {
    return { sig, count: 1, stage: "tweak", rewrites: prev.rewrites + 1 }
  }
  const count = prev.count + 1
  const rewrites = prev.rewrites
  if (count <= 3) return { sig, count, stage: "tweak", rewrites }
  if (count === 4) return { sig, count, stage: "analyze", rewrites }
  if (count === 5) return { sig, count, stage: "targeted_fix", rewrites }
  // count >= 6: rewrite once, then cycle (reset to tweak) so the ladder never permanently latches on rewrite.
  if (rewrites === 0) return { sig, count, stage: "rewrite", rewrites }
  return { sig, count: 1, stage: "tweak", rewrites }
}
