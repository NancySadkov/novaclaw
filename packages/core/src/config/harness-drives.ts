export * as ConfigHarnessDrives from "./harness-drives"

import { Schema } from "effect"

/**
 * The HARNESS DRIVES — bounded interventions for concrete failures. Live drives default ON; this
 * block exists so each can be turned OFF independently for measurement.
 *
 * 🔴 **Why a switch exists at all: without one, "can the model do this alone?" is unanswerable.**
 * A measurement taken under a mitigation measures the mitigation, so each remaining
 * failure-specific intervention has an explicit switch.
 *
 * ⭐ **The precedent is `thinkingBudget`**, whose comment in `schema/session-feature.ts` says it
 * exists *"so a budget change can be A/B'd in one chat without touching the instance default"*.
 * Same argument, one layer up: a harness feature you cannot switch off is a harness feature nobody
 * can measure.
 *
 * ⚠️ **Turning a live drive off makes the product WORSE, on purpose.** These are not preferences: each
 * exists because a measured failure needed it, and both are documented at their call sites. The
 * default is ON and a user who never touches this never notices it. AGENTS.md principle 12(a):
 * *work by default — a setting is an override, not a doorway.*
 */
export const Info = Schema.Struct({
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

/** Every live drive resolved to a plain boolean, defaults applied. */
export interface Resolved {
  /** Retired. Kept as a false literal until old set-controller state is removed. */
  readonly set: false
  readonly children: boolean
  readonly imageShortcut: boolean
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
    // Old settings may still carry `set: true`; it must not resurrect the retired file-list drive.
    set: false,
    children: info?.children ?? true,
    imageShortcut: info?.imageShortcut ?? true,
  }
}
