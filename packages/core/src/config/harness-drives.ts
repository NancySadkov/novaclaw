export * as ConfigHarnessDrives from "./harness-drives"

import { Schema } from "effect"

/**
 * The HARNESS DRIVES — the automatic continuations the harness applies to a turn that thinks it is
 * finished. Both default ON; this block exists so either can be turned OFF.
 *
 * 🔴 **Why a switch exists at all: without one, "can the model do this alone?" is unanswerable.**
 * `todo/batch-file-planning.md` records the gap in as many words — *every number this programme has
 * produced was taken with at least one drive live*, because `session.finish.reground` fires in every
 * session and is not gated on anything a prompt can change. So the programme's own baseline is a
 * measurement of the model PLUS a harness that marched it, and no arm the rig can select separates
 * them. A measurement taken under a mitigation measures the mitigation.
 *
 * ⭐ **The precedent is `thinkingBudget`**, whose comment in `schema/session-feature.ts` says it
 * exists *"so a budget change can be A/B'd in one chat without touching the instance default"*.
 * Same argument, one layer up: a harness feature you cannot switch off is a harness feature nobody
 * can measure.
 *
 * ⚠️ **INSTANCE-level, not per-session, and that is a deliberate narrowing.** The per-session feature
 * family (`schema/session-feature.ts`) carries a contract this does not need: a DB column, a
 * migration, and a composer control — *"a switch the kernel accepts while no surface offers it is
 * the ruling-2 shape safe mode itself was caught in."* These are operator/developer switches for a
 * measurement, so they ride the settings store like `provider_capability` and `tool_routing` do.
 * **If a per-session stance is ever wanted, promote them through the full nine-step chain rather
 * than widening this block** — half a feature in each place is how two answers to one question start.
 *
 * ⚠️ **Turning a drive off makes the product WORSE, on purpose.** These are not preferences: each
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
   * The unfinished-SET continuation (`unfinished-set.ts`): when the user asked about a set of files
   * and the turn ends with some unopened, the harness names the next batch and says not to stop.
   */
  set: Schema.optional(Schema.Boolean).annotate({
    description:
      "Steer a turn back to the rest of a set the user asked about, naming the next batch (default: true). " +
      "Turning this off lets a batch request stop wherever the model stops.",
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
})
export type Info = typeof Info.Type

/** Every drive resolved to a plain boolean, defaults applied. */
export interface Resolved {
  readonly reground: boolean
  readonly set: boolean
  readonly children: boolean
  readonly imageShortcut: boolean
}

/**
 * ⚠️ **Absent means ON.** `?? true` rather than a truthiness check, so an explicit `false` survives
 * and a missing block behaves exactly as the harness did before this key existed. The distinction
 * matters: `Config.latest` returns `undefined` for an unset key, and reading that as "off" would
 * silently disable all three drives on every instance that never set them.
 */
export const resolve = (info: Info | undefined): Resolved => ({
  reground: info?.reground ?? true,
  set: info?.set ?? true,
  children: info?.children ?? true,
  imageShortcut: info?.imageShortcut ?? true,
})
