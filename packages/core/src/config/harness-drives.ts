export * as ConfigHarnessDrives from "./harness-drives"

import { Schema } from "effect"

/**
 * The HARNESS DRIVES — the automatic continuations the harness applies to a turn that thinks it is
 * finished. Live drives default ON; this block exists so each can be turned OFF independently.
 *
 * 🔴 **Why a switch exists at all: without one, "can the model do this alone?" is unanswerable.**
 * Every earlier batch-file measurement was taken with at least one drive live, because
 * `session.finish.reground` fires in every
 * session and is not gated on anything a prompt can change. So the programme's own baseline is a
 * measurement of the model PLUS a harness that marched it, and no arm the rig can select separates
 * them. A measurement taken under a mitigation measures the mitigation.
 *
 * ⭐ **The precedent is `thinkingBudget`**, whose comment in `schema/session-feature.ts` says it
 * exists *"so a budget change can be A/B'd in one chat without touching the instance default"*.
 * Same argument, one layer up: a harness feature you cannot switch off is a harness feature nobody
 * can measure.
 *
 * ⚠️ **INSTANCE DEFAULT, with a per-agent re-ground override.** The per-session feature
 * family (`schema/session-feature.ts`) carries a contract this does not need: a DB column, a
 * migration, and a composer control — *"a switch the kernel accepts while no surface offers it is
 * the ruling-2 shape safe mode itself was caught in."* These are operator/developer switches for a
 * measurement, so they ride the settings store like `provider_capability` and `tool_routing` do.
 * Re-grounding alone also has a colleague-level stance because an officer may opt out without
 * changing its peers (`ConfigAgent.Info.reground` → `SessionEffectiveConfig`).
 * **If a per-session stance is ever wanted, promote it through the full nine-step chain rather
 * than widening this block** — half a feature in each place is how two answers to one question start.
 *
 * ⚠️ **Turning a live drive off makes the product WORSE, on purpose.** These are not preferences: each
 * exists because a measured failure needed it, and both are documented at their call sites. The
 * default is ON and a user who never touches this never notices it. AGENTS.md principle 12(a):
 * *work by default — a setting is an override, not a doorway.*
 */
export const Info = Schema.Struct({
  /**
   * The finish re-grounding nudge (`doom-loop.ts` `REGROUND_NUDGE`): when a substantial turn ends
   * with a confident, caveat-free summary, one re-prompt walks the model through its own acceptance
   * criteria.
   */
  reground: Schema.optional(Schema.Boolean).annotate({
    description:
      "Re-prompt a confident-sounding finish to walk its own acceptance criteria before stopping (default: true). " +
      "Turning this off removes the harness's last check on an over-confident summary — it exists for " +
      "measuring the model unaided, not as a preference.",
  }),
  /**
   * The FAN-OUT supervisor (`unjoined-children.ts`): when a turn finishes with children it spawned
   * but never joined, the harness names them and refuses the silent merge.
   */
  children: Schema.optional(Schema.Boolean).annotate({
    description:
      "Steer a turn back to child sessions it spawned but never read the results of (default: true). " +
      "Turning this off restores the silent failure where a merge of nine slices of ten looks complete.",
  }),
  /**
   * The image-shortcut refusal (`session/runner/image-shortcut.ts`), enforced in the `bash` tool.
   *
   * ⚠️ The odd one out: the other three STEER a finished turn, this one REFUSES a call before it
   * runs. It sits here anyway because it is the same kind of thing — an automatic harness
   * intervention an operator must be able to switch off to measure whether it converts.
   */
  imageShortcut: Schema.optional(Schema.Boolean).annotate({
    description:
      "Refuse a shell command that reads an image's BYTES (xxd/base64/cat on a PNG), which cannot " +
      "describe the picture, and name the read tool instead (default: true).",
  }),
  /**
   * 🔴 **RESUME A RUN THAT A CRASH INTERRUPTED** (owner, 2026-08-29: *"why are crashed runs lost
   * forever and can't be recovered / restored? Please ensure Nova can auto-restart, and there is an
   * option for that in Settings"*).
   *
   * Measured the same day: a serve carrying three sessions hung, the supervisor restarted it in one
   * second, the new child recovered all three session ROWS — and not one drain resumed. The work was
   * lost silently, and a client waiting on it could not tell "still working" from "recovered and
   * abandoned".
   *
   * ⭐ **The policy for this already existed and was simply never acted on.**
   * `SessionRecoveryDecision.decide` classifies every interrupted execution and sets `automatic` —
   * false after `FAILURE_LIMIT` consecutive failures (the circuit breaker), false when a tool was
   * dispatched with an unknown outcome (the side-effect hazard), true otherwise. The stale sweep
   * stores the verdict as `interrupted` vs `paused`. **Nothing woke the `interrupted` ones.** This
   * switch turns that verdict into an action; it does not add a policy.
   *
   * ⚠️ **So the crash-loop hazard is already bounded, and that is what makes ON safe.** A session
   * that keeps killing the instance is precisely the one most likely to be interrupted again — and
   * `FAILURE_LIMIT` pauses it on the third try rather than restarting it forever.
   */
  resumeInterrupted: Schema.optional(Schema.Boolean).annotate({
    description:
      "After a crash or restart, resume runs that were interrupted mid-turn (default: true). Only runs " +
      "the recovery policy already judged safe are resumed — an unknown tool outcome is inspected " +
      "before work continues, while a run that has failed repeatedly stays paused.",
  }),
})
export type Info = typeof Info.Type

/** Every live drive resolved to a plain boolean, defaults applied. */
export interface Resolved {
  readonly reground: boolean
  /** Retired. Kept as a false literal until old set-controller state is removed. */
  readonly set: false
  readonly children: boolean
  readonly imageShortcut: boolean
  readonly resumeInterrupted: boolean
}

/**
 * ⚠️ **Absent or malformed means ON.** The settings store is an unknown-data boundary, so the
 * whole block is schema-checked before any field is read. `?? true` then preserves an explicit
 * boolean `false`, while an unreadable block behaves exactly as the harness did before this key
 * existed. Reading malformed data as false would silently disable recovery or another drive.
 */
export const resolve = (value: unknown): Resolved => {
  const info = Schema.is(Info)(value) ? value : undefined
  return {
    reground: info?.reground ?? true,
    // Old settings may still carry `set: true`; it must not resurrect the retired file-list drive.
    set: false,
    children: info?.children ?? true,
    imageShortcut: info?.imageShortcut ?? true,
    resumeInterrupted: info?.resumeInterrupted ?? true,
  }
}
