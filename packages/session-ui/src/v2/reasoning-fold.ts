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

/** The default open-state for a tool card. Tool output is noisier than reasoning, so only the
 *  Developer ("open") level expands it by default — Normal and Advanced keep the feed clean and
 *  let the reader open a card on demand. (Unlike reasoning this is an UNCONTROLLED default: the
 *  Collapsible owns user toggles, so no live→collapse transition applies.) */
export const toolOpenDefault = (mode: ReasoningFoldMode): boolean => mode === "open"
