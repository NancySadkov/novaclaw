export * as ComputerLedger from "./ledger"

import type { ComputerProposal } from "./proposal"

/**
 * Computer Use 2.1 / S3 — the APPEND-ONLY step log, and the reason the loop's context is linear
 * rather than quadratic.
 *
 * 🔴 **This module is what replaces N screenshots with N short lines, and the number it replaces is
 * measured rather than feared.** `325d5c49f` made the `computer` tool return captured bytes as a
 * `Tool.Content` file part instead of a path — the right call, and it costs ~1,050 prompt tokens per
 * frame. Tool results are DURABLE, so a model-driven loop re-sends every prior screenshot on every
 * later step: `Σ (12,945 + 1,050·n)` over 25 steps is **≈665,000 prompt tokens**, quadratic in steps,
 * and `tool/computer.ts:140` states in-file that lowering cannot fix it because the bytes are already
 * in a settled tool result by then. Only a harness-owned loop can, and this is the mechanism:
 *
 * > **Exactly one image is in the planner's context at any step: the newest frame. Every older frame
 * > is represented by its ledger line.**
 *
 * So the growth term drops from 1,050·n to {@link LINE_TOKEN_CEILING}·n.
 *
 * ⚠️ **The design's "~30 tokens per line" is the TYPICAL cost; {@link LINE_TOKEN_CEILING} is 50
 * because a ceiling has to hold for the worst line, not the median one.** Measured over a rendered
 * 25-step run with realistic Master-of-Magic content, each additional step adds **27–37 tokens** — so
 * the design's figure is right about ordinary lines. 50 is what the field budgets guarantee when the
 * model writes 4,000 characters into every field, which is the case the ratchet exists for. Either
 * way the arithmetic that matters is unchanged: over 25 steps the ledger contributes at most
 * `50 × (0+1+…+24) = 15,000` tokens against the `315,000` the frames would have cost. **The ceiling
 * is a RATCHET: it may shrink, never grow** — a later editor who needs a wider field must take the
 * width from another one.
 *
 * 🔴 **Every field is collapsed to a single line before it is stored, and that is a guard rather than
 * formatting.** The action summary carries the model's own `type` text, read partly off an untrusted
 * screen. A newline inside it would forge an extra ledger line — a step that never happened, with a
 * verdict the harness never issued, in the harness's own voice. Whitespace collapse makes that
 * inexpressible; `renderLine` cannot emit a line break it was not asked for.
 *
 * ⚠️ **The table has two axes and the guard covers both.** A newline forges a ROW; the column
 * separator forges a COLUMN, out of the same untrusted text and into the same signed line, and it is
 * the half that was missing. `clip` now removes the separator's character as well, so no field can
 * open a column any more than it can open a line.
 *
 * ---
 *
 * 🔴 **WHAT IS STORED AND WHAT IS RE-SHOWN ARE DIFFERENT SETS, and that separation is a MEASURED fix
 * rather than a preference (2026-08-07).** The acceptance run missed
 * a menu row by ~40 normalized units against a 45-unit pitch, and the follow-up took it to measurement on one
 * frozen frame with mechanical ground truth, varying ONLY the ledger inside the run's own
 * reconstructed planner prompt:
 *
 * | ledger the planner was re-shown | correct menu row |
 * |---|---|
 * | empty | **10/10** |
 * | the run's own six real lines | **0/10** — every miss `New Game → Load Game`, the run's own failure |
 * | six NEUTRAL lines (every column `—`) | **10/10** |
 * | six real lines, PROSE COLUMNS DROPPED (this shape) | **10/10** |
 * | six real lines, only `expect` dropped | 8/10 |
 * | six real lines, only `observation` dropped | 6/10 |
 *
 * Two mechanism hypotheses died to their controls first: stripping the ledger's own coordinates did
 * not recover (0/10) and moving them to (900,900) pushed the answer *further* the other way, so it is
 * not anchoring; and neutral lines scoring 10/10 says the STEP LOG block itself is harmless. **It is
 * the model's own recorded PROSE** — its observations and its predictions — which make it answer from
 * its narrative instead of from the pixels. Neither prose column is innocent: dropping one leaves 8/10
 * and 6/10, and only dropping BOTH returns 10/10.
 *
 * So {@link Entry} keeps all six fields — the `RunReport` is item 2.2's artefact and a run a human
 * cannot read is not a measurement — and {@link renderLine} emits only the four MECHANICAL columns:
 * `n · action · verdict · checkpoint`. That is precisely what the planner needs the log for, which is
 * to tell *"I tried that and it did nothing"* from *"I have not tried that"* (G6's repeat interlock
 * and G13's autolock signature are both mechanical, in the reducer — they never read this string).
 *
 * ⚠️ **Deleting the ledger was never an option and is not what this is.** The ledger is what makes the
 * run's cost LINEAR (G11: exactly one image in context, older frames represented by their line); the
 * acceptance run measured ≈96,000 prompt tokens over 25 steps *with* it against the naive loop's
 * 638,625. Dropping the two prose columns makes it **cheaper**, not absent — the run's own six lines
 * render at 569 characters instead of 1,205.
 */

// ---------------------------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------------------------

/**
 * One step, as the RUN RECORDS it.
 *
 * The six fields are the design's: `n · observation · action · expect · verdict · checkpoint` — the
 * four things the model committed to plus the two things the harness measured.
 *
 * ⚠️ **Not all six are re-shown to the planner.** {@link renderLine} emits the mechanical four; the
 * two prose columns are kept here for the report and withheld from the prompt, for the measured
 * reason in the module note. Adding a field here does NOT put it in front of the model, and that is
 * deliberate: this type is the record, {@link renderLine} is the prompt.
 */
export interface Entry {
  readonly n: number
  /** What the model said it saw. */
  readonly observation: string
  /** What it did, rendered by {@link summarizeAction} — never the raw argv. */
  readonly action: string
  /** What it predicted would be visible afterwards. */
  readonly expect: string
  /** What the harness measured: an attribution kind, a refusal, or a rejection. */
  readonly verdict: string
  /** Checkpoint standing after the step, e.g. `3/9`. */
  readonly checkpoint: string
}

/**
 * Per-field character budgets. The RENDERED fields' sum + separators + the step number is
 * {@link LINE_CHAR_CEILING}; `observation` and `expect` are budgets for the RECORD only, since those
 * two columns never reach the prompt.
 *
 * ⚠️ **`verdict` carries the harness's own MEASUREMENT, so its budget is sized so that no measurement
 * is ever clipped** — a truncated verdict is a lie about what was observed rather than an abbreviated
 * sentence. The longest one the ladder can produce is `needs-adjudication` (18) plus the `/pred:yes`
 * suffix (9) = 27, and `ledger.test.ts` pins every `ComputerEvidence.Attribution` kind against this
 * number so a new outcome name cannot silently start truncating. Free-text details (a `build`
 * refusal, a driver's exec error) are advisory prose and MAY clip — that is the difference between a
 * measurement and an explanation.
 */
export const FIELD_LIMIT = {
  observation: 52,
  action: 28,
  expect: 56,
  verdict: 28,
  checkpoint: 10,
} as const

const SEPARATOR = " · "

/**
 * The separator's own character.
 *
 * 🔴 **A field may not contain it.** The module note's guard is about the ROW separator — a newline
 * would forge a whole extra step — and this is the same guard for the COLUMN separator. `type "a ·
 * attributed · 9/9"` is one field the model wrote; joined with {@link SEPARATOR} it renders as six
 * ` · `-delimited fields under a four-column header, so the log the harness signs carries a verdict
 * the harness never issued and a checkpoint count it never awarded, standing ahead of the real ones.
 * The planner is re-shown this log every step and the pre-action critic reads it as context.
 *
 * The character is REPLACED rather than escaped, because escaping leaves the forgery merely
 * expensive: any escape has to survive whitespace collapse and the clip's own ellipsis, and a field
 * truncated mid-escape is a new way to end up with a stray separator. With the character gone there
 * is no spacing and no truncation that can reconstruct one, so a forged column is impossible rather
 * than unlikely, and every line of `render` splits into exactly four fields for every input — which
 * is the property the test asserts, on the PARSED line rather than on the string.
 */
const SEPARATOR_CHAR = /·/g

/** What a separator character in model- or screen-sourced text is rewritten to. Not a separator. */
const SEPARATOR_REPLACEMENT = "-"

/**
 * Ratchet. May shrink, never grow — see the module note. **Shrunk 200 → 80 on 2026-08-07**, which is
 * what dropping the two prose columns is worth: the worst renderable line is now
 * `9999 · <28> · <28> · <10>` = 79 characters.
 */
export const LINE_CHAR_CEILING = 80

/** Ratchet, at the repo's ~4 chars/token estimate. May shrink, never grow. **Shrunk 50 → 20.** */
export const LINE_TOKEN_CEILING = 20

/** Shown for a field the step never produced, so the column count is constant. */
export const ABSENT = "—"

/**
 * Collapse to one line, drop the column separator, trim, and clip to `limit` with an ellipsis.
 *
 * The whitespace collapse and the separator strip are the SAME guard, one per axis of the table: a
 * newline forges a row, a ` · ` forges a column, and both arrive through the same untrusted text.
 * Doing it here rather than in {@link renderLine} is what makes it hold for a column added later —
 * every rendered field goes through this function, so a field that cannot break the line is also a
 * field that cannot open a column. The clip is the separate concern: it is what makes growth per
 * step bounded no matter how much prose the model writes.
 */
export const clip = (text: string | null | undefined, limit: number): string => {
  const flat = (text ?? "").replace(/\s+/g, " ").replace(SEPARATOR_CHAR, SEPARATOR_REPLACEMENT).trim()
  if (flat === "") return ABSENT
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * The model's action, in the log's vocabulary.
 *
 * ⚠️ **Deliberately NOT the argv.** `["xdotool","mousemove","594","547"]` plus
 * `["xdotool","click","1"]` is ~40 characters of tool syntax for one click, and it describes the
 * harness's plumbing rather than the model's decision. The planner needs to recognise *what it
 * already tried*, and under the split contract it tried `click "DONE"`, not a coordinate the
 * harness's grounder supplied later.
 */
export const summarizeAction = (action: ComputerProposal.ActionDraft | null | undefined): string => {
  if (action == null) return ABSENT
  const kind = typeof action.kind === "string" ? action.kind.trim() : ""
  if (kind === "") return ABSENT
  const target = action.target == null ? "" : ` "${action.target}"`
  switch (kind) {
    case "move":
    case "double_click":
      return `${kind}${target}`
    case "click":
      return `${action.button == null || action.button === "left" ? "click" : `${action.button}-click`}${target}`
    case "type":
      return `type "${action.text ?? ""}"`
    case "type_submit":
      return `type_submit "${action.text ?? ""}"`
    case "key":
      return `key ${action.keys ?? ""}`
    case "scroll":
      return `scroll ${action.direction ?? ""}×${action.amount ?? ""}`
    default:
      return `${kind}${target}`
  }
}

/**
 * The columns the PLANNER is re-shown, in order. `observation` and `expect` are deliberately absent —
 * see the module note's table. **This list is the fix**; a later editor who adds a prose column back
 * is re-introducing a measured 100% → 0% grounding collapse, so `ledger.test.ts` pins it by name.
 */
export const RENDERED_COLUMNS = ["action", "verdict", "checkpoint"] as const

/** `n · action · verdict · checkpoint`, one line, always four columns. */
export const renderLine = (entry: Entry): string =>
  [
    String(entry.n),
    clip(entry.action, FIELD_LIMIT.action),
    clip(entry.verdict, FIELD_LIMIT.verdict),
    clip(entry.checkpoint, FIELD_LIMIT.checkpoint),
  ].join(SEPARATOR)

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

export type Ledger = ReadonlyArray<Entry>

export const empty: Ledger = []

/**
 * Append one step. Returns a NEW ledger; nothing already in it is touched.
 *
 * 🔴 **Append-only is a prompt-cache property, not tidiness.** vLLM prefix-caches on an exact token
 * prefix, so the run pays for the preamble + the whole log once instead of once per step — but only
 * while every earlier line renders byte-identically. Editing or re-summarising a past line
 * invalidates the cache from that point on every remaining step, which is the expensive way to save
 * a few tokens. {@link render} of `n` entries is therefore a byte-exact prefix of `render` of `n+1`,
 * and a test pins it.
 */
export const append = (ledger: Ledger, entry: Entry): Ledger => [...ledger, entry]

/** The whole log. Empty ledger → empty string, so the caller's header can say "nothing yet". */
export const render = (ledger: Ledger): string => ledger.map(renderLine).join("\n")

/** Chars of a line, before it is joined. Used by the ratchet test and by the budget estimate. */
export const lineLength = (entry: Entry): number => renderLine(entry).length

/** The column header, so a floor model reads the log as a table rather than as prose. */
export const HEADER = "n · did · measured · checkpoint"
