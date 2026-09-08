// UIX residue (b) / C4 — level-aware reasoning-fold defaults (uix.md §6: teach-don't-gatekeep).
// The expertise level picks how much of an assistant's reasoning the feed shows by default:
//   - "collapsed" (Normal): reasoning stays folded — a non-expert sees the answer, not the
//     machinery, and opens it only if curious.
//   - "live" (Advanced): open WHILE the model reasons (you watch it think), collapse once the
//     TURN settles so the finished transcript stays tidy. Not once the part completes — that
//     shortened a running turn under a reader pinned to its bottom (see `reasoningOpenDefault`).
//   - "open" (Developer): always expanded — the full trace, all the time.
// This is only the DEFAULT: a user toggle always wins over it (native-transcript tracks the
// override), so nobody is ever locked out of a fold they opened.

export type ReasoningFoldMode = "collapsed" | "live" | "open"

/**
 * The default open-state for a reasoning `<details>`, given the fold mode, whether the reasoning
 * part itself has finished streaming, and whether the TURN has settled.
 *
 * 🔴 **`settled` is the fix for the mid-turn rewind (owner, 2026-09-04):** *"when the chat slider is
 * at the bottom and the model is Working, sometimes the chat gets rewinded to the start of the
 * user's prompt"*.
 *
 * `live` used to collapse on `completed` alone — the moment that ONE reasoning part stopped
 * streaming, while the turn kept running. A reasoning trace is the tallest thing in a working turn,
 * so collapsing it removes hundreds of pixels from a transcript the reader is pinned to the bottom
 * of. The pin is not lost and nothing scrolls: the bottom simply moves up, past everything the
 * reader was looking at, and on a turn now shorter than the viewport that lands on the start of
 * their own prompt. Measured in a real Chromium: folding a 1600px block moved `scrollTop` from
 * 2457 to 881 with `pinned` true throughout. Repeats per step, which is the "sometimes".
 *
 * ⚠️ **It contradicted the rule the transcript is built on**, stated in `native-transcript.tsx` and
 * obeyed by `foldClosing`: *"While it runs, everything shows. Watching the work IS the feedback — a
 * fold that hides a running turn reads as a hang. Once it settles, the work collapses under one
 * control."* The comment above this function said the same thing in its own words — collapse *"once
 * the reasoning part completes so the SETTLED transcript stays tidy"* — and then keyed the decision
 * on the part rather than the transcript. Both halves of that sentence were right; only the
 * subject was wrong.
 *
 * So `live` now means: open while the model is thinking, open while the turn is still running, and
 * tidied away once the turn is done. The other two modes never had this problem — `collapsed` is
 * never open and `open` never closes, so neither can change height under the reader.
 */
export const reasoningOpenDefault = (mode: ReasoningFoldMode, completed: boolean, settled = true): boolean => {
  switch (mode) {
    case "open":
      return true
    case "collapsed":
      return false
    case "live":
      return !completed || !settled
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
