// UIX residue (b) / C4 — level-aware reasoning-fold defaults (uix.md §6: teach-don't-gatekeep).
// The expertise level picks how much of an assistant's reasoning the feed shows by default:
//   - "collapsed" (Normal): reasoning stays folded — a non-expert sees the answer, not the
//     machinery, and opens it only if curious.
//   - "live" (Advanced): open WHILE the model reasons (you watch it think), collapse once the
//     reasoning part completes so the settled transcript stays tidy.
//   - "open" (Developer): always expanded — the full trace, all the time.
// This is only the DEFAULT: a user toggle always wins over it (native-transcript tracks the
// override), so nobody is ever locked out of a fold they opened.

export type ReasoningFoldMode = "collapsed" | "live" | "open"

/** The default open-state for a reasoning `<details>` given the fold mode and whether the
 *  reasoning part itself has finished streaming. */
export const reasoningOpenDefault = (mode: ReasoningFoldMode, completed: boolean): boolean => {
  switch (mode) {
    case "open":
      return true
    case "collapsed":
      return false
    case "live":
      return !completed
  }
}

/**
 * Does a settled message's reasoning live INSIDE its Details receipt, rather than beside it?
 *
 * 🔴 Owner, 2026-09-03, holding a screenshot of a four-step answer: *"the reasoning is not hidden
 * inside of the Details fold, so clutters the chat window. Most users will only look at the model
 * reasoning if something is wrong."* One `Reasoning` row per step down the left of a single reply is
 * the machinery competing with the answer.
 *
 * ⚠️ **The `timing` half is not a detail — without it the parts would be DELETED, not moved.** The
 * receipt only draws its `<details>` when it has timing to show, so a message with reasoning and no
 * timing has no fold to be folded into, and its reasoning must stay where it is. Same for the
 * `answer` half of a split message, which deliberately renders no receipt: its chrome belongs to the
 * answer, outside the fold. A part never disappears; it only changes parent.
 */
export const reasoningGoesInReceipt = (input: {
  readonly half?: "work" | "answer"
  readonly hasTiming: boolean
}): boolean => input.half !== "answer" && input.hasTiming

/** The default open-state for a tool card. Tool output is noisier than reasoning, so only the
 *  Developer ("open") level expands it by default — Normal and Advanced keep the feed clean and
 *  let the reader open a card on demand. (Unlike reasoning this is an UNCONTROLLED default: the
 *  Collapsible owns user toggles, so no live→collapse transition applies.) */
export const toolOpenDefault = (mode: ReasoningFoldMode): boolean => mode === "open"
