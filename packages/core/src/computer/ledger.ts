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
 * formatting.** The observation and the prediction are model-authored text read partly off an
 * untrusted screen. A newline inside one of them would forge an extra ledger line — a step that never
 * happened, with a verdict the harness never issued, in the harness's own voice. Whitespace collapse
 * makes that inexpressible; `renderLine` cannot emit a line break it was not asked for.
 */

// ---------------------------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------------------------

/**
 * One step, as the planner sees it on every later step.
 *
 * The six fields are the design's: `n · observation · action · expect · verdict · checkpoint`. They
 * are the four things the model committed to plus the two things the harness measured, which is
 * exactly the pairing that lets the planner tell "I tried that and it did nothing" from "I have not
 * tried that".
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
 * Per-field character budgets. Sum + separators + the step number is {@link LINE_CHAR_CEILING}.
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

/** Ratchet. May shrink, never grow — see the module note. */
export const LINE_CHAR_CEILING = 200

/** Ratchet, at the repo's ~4 chars/token estimate. May shrink, never grow. */
export const LINE_TOKEN_CEILING = 50

/** Shown for a field the step never produced, so the column count is constant. */
export const ABSENT = "—"

/**
 * Collapse to one line, trim, and clip to `limit` with an ellipsis.
 *
 * The whitespace collapse is the guard described in the module note; the clip is what makes growth
 * per step bounded no matter how much prose the model writes.
 */
export const clip = (text: string | null | undefined, limit: number): string => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  if (flat === "") return ABSENT
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * The model's action, in the log's vocabulary.
 *
 * ⚠️ **Deliberately NOT the argv.** `["xdotool","mousemove","594","547"]` plus
 * `["xdotool","click","1"]` is ~40 characters of tool syntax for one click, and it describes the
 * harness's plumbing rather than the model's decision. The planner needs to recognise *what it
 * already tried*, and it tried "click (464,684)".
 */
export const summarizeAction = (action: ComputerProposal.ActionDraft | null | undefined): string => {
  if (action == null) return ABSENT
  const kind = typeof action.kind === "string" ? action.kind.trim() : ""
  if (kind === "") return ABSENT
  const point = action.point == null ? "" : `(${action.point.x},${action.point.y})`
  switch (kind) {
    case "move":
    case "double_click":
      return `${kind}${point}`
    case "click":
      return `${action.button == null || action.button === "left" ? "click" : `${action.button}-click`}${point}`
    case "type":
      return `type "${action.text ?? ""}"`
    case "key":
      return `key ${action.keys ?? ""}`
    case "scroll":
      return `scroll ${action.direction ?? ""}×${action.amount ?? ""}`
    default:
      return `${kind}${point}`
  }
}

/** `n · observation · action · expect · verdict · checkpoint`, one line, always six columns. */
export const renderLine = (entry: Entry): string =>
  [
    String(entry.n),
    clip(entry.observation, FIELD_LIMIT.observation),
    clip(entry.action, FIELD_LIMIT.action),
    clip(entry.expect, FIELD_LIMIT.expect),
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
export const HEADER = "n · saw · did · predicted · measured · checkpoint"
