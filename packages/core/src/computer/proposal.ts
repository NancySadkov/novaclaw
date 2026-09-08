export * as ComputerProposal from "./proposal"

import { Schema } from "effect"
import { isRecord } from "@novaclaw/schema/record"
import { JhExtract } from "../jh/extract"

/**
 * Computer Use 2.1 / S1 — the PLANNER's wire schema: what one proposal from the model looks like,
 * how it is decoded when the floor model gets it slightly wrong, and what the harness says back when
 * it gets it wrong in a way that cannot be repaired silently.
 *
 * **Three legal shapes, and exactly one per reply:**
 *
 * | shape | fields | meaning |
 * |---|---|---|
 * | act | `{observation, action, expect}` | do one thing, and say what the screen should look like afterwards |
 * | abstain | `{abstain, reason}` | *"I cannot see the target"* — A14.3, first-class |
 * | claim done | `{claim_done, evidence}` | a PROPOSAL, never a transition (G1) |
 *
 * 🔴 **`expect` is REQUIRED on an act, and that is the whole point of the schema.** Rung 2 of the
 * verification ladder adjudicates a *prior commitment*: the adjudicator is shown the after-frame and
 * the prediction sentence, and nothing else — no goal, no plan, no action. A proposal with no
 * prediction leaves nothing to adjudicate, so the step's only evidence is a digest, and on an
 * animated screen a digest says nothing. A model that skips `expect` therefore silently downgrades
 * the run to the state the 08-06 substrate probe was in, where all three steps came back
 * `inconclusive (animated)` and the loop was blind. It is caught here, mechanically, because
 * the floor model ignores negative instructions and a sentence in a prompt is not a constraint.
 *
 * 🔴 **Pointer actions name the control's visible LABEL and never propose coordinates.** The split
 * grounding call owns the point; the harness derives the watch region around that grounded point.
 * This is the measured 25/25 path. Keeping planner coordinates as an accepted alternative would
 * silently retain the shipped 7/25 path beside it.
 *
 * **The decode is TOLERANT and the validation is SEPARATE, which is `jh/step.ts`'s pattern and it is
 * here for `jh/step.ts`'s reason.** The engine needs the parsed draft in order to build the repair
 * re-prompt: a reply rejected by the codec can only be answered with a schema error, while a reply
 * that decodes and then fails `structuralIssues` can be answered with *"you emitted a click at
 * (594,547) and a watch box that does not contain it"*. So every optional field also accepts `null`
 * (measured on qwen 2026-07-09: small models write `"watch": null` rather than omitting the key),
 * and every contradiction the codec would have to reject is caught below instead.
 *
 * ⚠️ **What this module deliberately does NOT do.** It does not convert coordinates (that is
 * `coordinates.ts`, and the space is DECLARED per model — never sniffed, G8), it does not build argv
 * (`actions.ts`), and it does not validate action PAYLOADS beyond their presence: a keysym spec, a
 * scroll bound, whole-pixel integrality and an empty `type` string are all `ComputerActions.build`'s
 * to reject, at the Guard, in the one place that knows the tool. Duplicating them here would create a
 * second opinion about `xdotool`, and this program has already paid once for a unit test that pinned
 * the author's belief about a tool rather than the tool (`xdotool --display`, a flag that does not
 * exist, under 23 green tests).
 */

// ---------------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * The actions a planner may propose.
 *
 * ⚠️ **`screenshot` and `cursor` are absent, and their absence is load-bearing.** Both are
 * observations the HARNESS owns: the four-capture protocol requires (idle, idle, act, after) with
 * *nothing* between the idle pair, and a model that can insert a capture of its own can break that
 * invisibly. A model proposing one is not an error to be silently dropped (ruling 2) — it is
 * reported by name, so the repair prompt can say *"the harness captures; propose an action"*.
 */
export const ACTION_KINDS = ["move", "click", "double_click", "type", "type_submit", "key", "scroll"] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

/** Kinds that aim at a point, and therefore need a watch region containing it. */
export const POINTER_KINDS = ["move", "click", "double_click"] as const
export type PointerKind = (typeof POINTER_KINDS)[number]

/** Kinds the harness owns. Proposing one is a structural error, not an unknown kind. */
export const HARNESS_OWNED_KINDS = ["screenshot", "cursor"] as const

export const isActionKind = (kind: string): kind is ActionKind => (ACTION_KINDS as ReadonlyArray<string>).includes(kind)

export const isPointerKind = (kind: string): kind is PointerKind =>
  (POINTER_KINDS as ReadonlyArray<string>).includes(kind)

/** The payload field each kind cannot be executed without. Presence only — values belong to `build`. */
const REQUIRED_PAYLOAD: Partial<Record<ActionKind, ReadonlyArray<"text" | "keys" | "direction" | "amount">>> = {
  type: ["text"],
  type_submit: ["text"],
  key: ["keys"],
  scroll: ["direction", "amount"],
}

// ---------------------------------------------------------------------------------------------
// The wire schema
// ---------------------------------------------------------------------------------------------

/**
 * A point in the MODEL's declared output space — normalized 0–1000 for `holo3.1`, and never
 * inferred from the numbers (`coordinates.ts`). Both fields are required: a point with one axis is
 * not a point, and letting it decode would push the failure downstream where it reads as a misclick.
 */
export interface PointDraft {
  readonly x: number
  readonly y: number
}
export const PointDraft = Schema.Struct({ x: Schema.Number, y: Schema.Number })

/**
 * The watch rectangle, in the SAME units as the point beside it.
 *
 * ⚠️ **All four fields are required, and that is the same property `tool/computer.ts` bought with its
 * `"x,y,width,height"` string:** a half-built rectangle cannot be expressed, so it can never be
 * silently completed with a default. Here it is enforced by the codec rather than by a parser, which
 * is why a partial region shows up as a decode failure the repair prompt quotes.
 */
export interface RegionDraft {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
export const RegionDraft = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})

export interface ActionDraft {
  /** Optional in the CODEC on purpose — an absent or unknown kind is reported structurally, so the
   *  repair prompt can name what was actually written instead of a schema error. */
  readonly kind?: string | null
  /** Pointer actions: the control's visible label, with no positional description. */
  readonly target?: string | null
  /** Decode-only legacy fields. Structural validation rejects them so the repair can name the drift. */
  readonly point?: PointDraft | null
  readonly button?: string | null
  readonly text?: string | null
  readonly keys?: string | null
  readonly direction?: string | null
  readonly amount?: number | null
}
export const ActionDraft = Schema.Struct({
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  target: Schema.optional(Schema.NullOr(Schema.String)),
  point: Schema.optional(Schema.NullOr(PointDraft)),
  button: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  keys: Schema.optional(Schema.NullOr(Schema.String)),
  direction: Schema.optional(Schema.NullOr(Schema.String)),
  amount: Schema.optional(Schema.NullOr(Schema.Number)),
})

/**
 * ONE struct for all three shapes — `jh/step.ts`'s decision, for its reason: a single tolerant codec
 * plus a structural pass beats a tagged union that rejects the reply before anyone can quote it.
 */
export interface ProposalDraft {
  readonly observation?: string | null
  readonly action?: ActionDraft | null
  readonly expect?: string | null
  readonly watch?: RegionDraft | null
  readonly abstain?: boolean | null
  readonly reason?: string | null
  readonly claim_done?: boolean | null
  readonly evidence?: string | null
}
export const ProposalDraft = Schema.Struct({
  observation: Schema.optional(Schema.NullOr(Schema.String)),
  action: Schema.optional(Schema.NullOr(ActionDraft)),
  expect: Schema.optional(Schema.NullOr(Schema.String)),
  watch: Schema.optional(Schema.NullOr(RegionDraft)),
  abstain: Schema.optional(Schema.NullOr(Schema.Boolean)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  claim_done: Schema.optional(Schema.NullOr(Schema.Boolean)),
  evidence: Schema.optional(Schema.NullOr(Schema.String)),
})

// ---------------------------------------------------------------------------------------------
// Shape tolerance
// ---------------------------------------------------------------------------------------------

/** A number, or a string that is entirely one finite numeral. Anything else passes through. */
const numeric = (v: unknown): unknown => {
  if (typeof v !== "string") return v
  const trimmed = v.trim()
  if (trimmed === "") return v
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : v
}

/** `[x, y]` · `{x, y}` — the two forms a grounder emits. Anything else passes through untouched. */
const coercePoint = (v: unknown): unknown => {
  if (Array.isArray(v) && v.length === 2) return { x: numeric(v[0]), y: numeric(v[1]) }
  if (!isRecord(v)) return v
  return { ...v, ...(v.x === undefined ? {} : { x: numeric(v.x) }), ...(v.y === undefined ? {} : { y: numeric(v.y) }) }
}

/**
 * `"x,y,w,h"` · `[x,y,w,h]` · `{x,y,width,height}` · `{x,y,w,h}`.
 *
 * ⚠️ **The string form is not speculation — it is the shape OUR OWN tool advertises.** `computer`'s
 * `region` input is the string `"x,y,width,height"` (it was made a string to get the tool out of the
 * resident set), so a model that has ever seen this tool's schema has been taught to write a region
 * that way. Refusing it here would reject the model for having read our documentation.
 */
const coerceRegion = (v: unknown): unknown => {
  if (typeof v === "string") {
    const parts = v.split(",").map((p) => p.trim())
    if (parts.length !== 4) return v
    const [x, y, width, height] = parts.map(numeric)
    return { x, y, width, height }
  }
  if (Array.isArray(v) && v.length === 4) {
    const [x, y, width, height] = v.map(numeric)
    return { x, y, width, height }
  }
  if (!isRecord(v)) return v
  const out: Record<string, unknown> = { ...v }
  if (out.width === undefined && out.w !== undefined) out.width = out.w
  if (out.height === undefined && out.h !== undefined) out.height = out.h
  for (const key of ["x", "y", "width", "height"]) if (out[key] !== undefined) out[key] = numeric(out[key])
  return out
}

/**
 * A boolean flag the floor model wrote as prose. `{"abstain": "I cannot see the target"}` is the
 * shape to expect, because the field NAME already carries the meaning and the model fills it with
 * the only thing it has left to say. Returns the flag plus the text it displaced, so the caller can
 * put that text where it belongs (`reason` / `evidence`).
 */
const coerceFlag = (v: unknown): { readonly flag: unknown; readonly displaced?: string } => {
  if (typeof v !== "string") return { flag: v }
  const normalized = v.trim().toLowerCase()
  if (normalized === "true" || normalized === "yes") return { flag: true }
  if (normalized === "false" || normalized === "no") return { flag: false }
  if (normalized === "") return { flag: v }
  return { flag: true, displaced: v }
}

/**
 * Pre-decode shape tolerance. Pure and total — a non-object passes through unchanged.
 *
 * 🔴 **The FLAT form is the one that matters most, and it is our own fault.** `tool/computer.ts`'s
 * Input is flat — `{action: "click", x, y, button, text, keys, direction, amount, region}` — so a
 * model that has been shown the `computer` tool has been trained by us to emit exactly that, not the
 * nested `{action: {kind, point}}` this schema wants. Rejecting it would be rejecting our own
 * teaching. So a string `action` becomes `{kind}`, and the flat payload keys are hoisted into it.
 * (Hoisting only fills fields the nested action left empty, so an explicit nested value always wins.)
 */
export function coerceProposalShape(value: unknown): unknown {
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = { ...value }

  // ── the act shape ─────────────────────────────────────────────────────────────────────────
  if (typeof out.action === "string") out.action = { kind: out.action }
  if (isRecord(out.action)) {
    const action: Record<string, unknown> = { ...out.action }
    // `{"action": {"action": "click"}}` and `{"action": {"type": "click"}}` — the field renamed after
    // the model flattened it once already.
    if (action.kind == null && typeof action.action === "string") action.kind = action.action
    if (action.kind == null && typeof action.type === "string") action.kind = action.type
    for (const key of ["target", "button", "text", "keys", "direction", "amount"]) {
      if (action[key] == null && out[key] != null) action[key] = out[key]
    }
    if (action.amount !== undefined) action.amount = numeric(action.amount)
    // The point: nested, or flat x/y on the action, or flat x/y on the proposal itself.
    const flatOnAction = action.x != null && action.y != null ? { x: action.x, y: action.y } : undefined
    const flatOnRoot = out.x != null && out.y != null ? { x: out.x, y: out.y } : undefined
    const point = action.point ?? flatOnAction ?? flatOnRoot
    if (point !== undefined && point !== null) action.point = coercePoint(point)
    // 🔴 The INVERSE of the hoist above, and it is measured rather than imagined. On the
    // checkpoint-9 frame, **27 of 50** planner replies put `watch` INSIDE `action` beside `point`
    // — which reads as the more natural place, since `watch` is a property of the action — and the
    // decoder then dropped it, so `structuralIssues` reported `missing_watch` on **25 of 50** and
    // the step spent its ONE repair on shape. Run C shows the same note live. Lifting it is the
    // same tolerance the flat form already gets, in the other direction.
    // ⚠️ Only when the proposal has none of its own: an explicit top-level `watch` always wins, so
    // this can never overwrite what the model actually put where the schema asks for it.
    if (out.watch == null && out.region == null) {
      const nested = action.watch ?? action.region
      if (nested !== undefined && nested !== null) out.watch = nested
    }
    out.action = action
  }

  // `expected` is what `jh`'s own Check vocabulary calls this field, so a model that has seen the
  // harness's other schema reaches for it here.
  if (out.expect == null && typeof out.expected === "string") out.expect = out.expected

  // `region` is the tool's name for the same rectangle; accept it as an alias for `watch`.
  const watch = out.watch ?? out.region
  if (watch !== undefined && watch !== null) out.watch = coerceRegion(watch)

  // ── the abstain and claim-done shapes ─────────────────────────────────────────────────────
  if (out.abstain !== undefined) {
    const { flag, displaced } = coerceFlag(out.abstain)
    out.abstain = flag
    if (displaced !== undefined && out.reason == null) out.reason = displaced
  }
  if (out.claim_done !== undefined) {
    const { flag, displaced } = coerceFlag(out.claim_done)
    out.claim_done = flag
    if (displaced !== undefined && out.evidence == null) out.evidence = displaced
  }

  return out
}

// ---------------------------------------------------------------------------------------------
// Structural validation — what the codec cannot express
// ---------------------------------------------------------------------------------------------

export type IssueCode =
  /** None of the three legal shapes is present. */
  | "no_proposal"
  /** More than one is. */
  | "ambiguous_shape"
  /** An act with no prediction — nothing for rung 2 to adjudicate. */
  | "missing_expect"
  /** An act with no `observation` line (warning: it costs prompt quality, not verifiability). */
  | "missing_observation"
  | "unknown_action_kind"
  /** `screenshot` / `cursor` — the harness owns capture. */
  | "harness_owned_action"
  /** A pointer action with no visible label for the split grounder. */
  | "pointer_missing_target"
  /** Planner-authored coordinates/watch would bypass the measured split path. */
  | "planner_grounding_fields"
  /** The kind's payload field is absent, so no action can be built at all. */
  | "missing_action_payload"
  | "abstain_missing_reason"
  | "claim_done_missing_evidence"

export interface StructuralIssue {
  readonly severity: "error" | "warning"
  readonly code: IssueCode
  /** The field that is wrong, e.g. `action.point` — quoted back in the repair prompt. */
  readonly path: string
  readonly detail?: string
}

const blank = (v: string | null | undefined): boolean => v == null || v.trim() === ""

/**
 * Pure and total. A codec-valid draft can still be structurally wrong; this is what catches it, and
 * what the repair re-prompt is rendered from.
 *
 * "error" is grounds to reject-and-repair. "warning" is tolerated — the harness proceeds and the
 * planner is told, because spending the repair budget on an abstention with no reason would punish
 * exactly the behaviour A14.3 exists to encourage (G12: `abstain` is a legal shape, not an error).
 */
export function structuralIssues(draft: ProposalDraft): ReadonlyArray<StructuralIssue> {
  const issues: StructuralIssue[] = []
  const acting = draft.action != null
  const abstaining = draft.abstain === true
  const claiming = draft.claim_done === true
  const shapes = [acting, abstaining, claiming].filter(Boolean).length

  if (shapes === 0) {
    issues.push({
      severity: "error",
      code: "no_proposal",
      path: "",
      detail: "expected one of `action` + `expect`, `abstain` + `reason`, or `claim_done` + `evidence`",
    })
  }
  if (shapes > 1) {
    // 🔴 Not pedantry: `claim_done` is adjudicated against a frame the harness captured (G1). Pairing
    // it with an action that has not run yet asks for a verdict on a screen that does not exist.
    issues.push({
      severity: "error",
      code: "ambiguous_shape",
      path: "",
      detail: [acting && "action", abstaining && "abstain", claiming && "claim_done"].filter(Boolean).join(" + "),
    })
  }

  if (abstaining && blank(draft.reason)) {
    issues.push({ severity: "warning", code: "abstain_missing_reason", path: "reason" })
  }
  if (claiming && blank(draft.evidence)) {
    issues.push({ severity: "warning", code: "claim_done_missing_evidence", path: "evidence" })
  }

  const action = draft.action
  if (action == null) return issues

  const kind = typeof action.kind === "string" ? action.kind.trim() : ""

  if (blank(draft.expect)) {
    issues.push({
      severity: "error",
      code: "missing_expect",
      path: "expect",
      detail: "an action with no prediction cannot be adjudicated, so the step produces no evidence",
    })
  }
  if (blank(draft.observation)) {
    issues.push({ severity: "warning", code: "missing_observation", path: "observation" })
  }

  if ((HARNESS_OWNED_KINDS as ReadonlyArray<string>).includes(kind)) {
    issues.push({
      severity: "error",
      code: "harness_owned_action",
      path: "action.kind",
      detail: kind,
    })
    return issues
  }
  if (!isActionKind(kind)) {
    issues.push({
      severity: "error",
      code: "unknown_action_kind",
      path: "action.kind",
      detail: kind === "" ? "(absent)" : kind,
    })
    return issues
  }

  for (const field of REQUIRED_PAYLOAD[kind] ?? []) {
    if (action[field] == null) {
      issues.push({ severity: "error", code: "missing_action_payload", path: `action.${field}`, detail: kind })
    }
  }

  if (!isPointerKind(kind)) return issues

  if (blank(action.target)) {
    issues.push({ severity: "error", code: "pointer_missing_target", path: "action.target", detail: kind })
  }
  if (action.point != null || draft.watch != null) {
    issues.push({
      severity: "error",
      code: "planner_grounding_fields",
      path: action.point != null ? "action.point" : "watch",
      detail: "the blind grounder owns the point and the harness owns its watch region",
    })
  }

  return issues
}

export const errorsOf = (issues: ReadonlyArray<StructuralIssue>): ReadonlyArray<StructuralIssue> =>
  issues.filter((i) => i.severity === "error")

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export type ParseResult =
  | { readonly ok: true; readonly draft: ProposalDraft; readonly repairs?: ReadonlyArray<RepairKind> }
  | { readonly ok: false; readonly issue: string }

/** A named textual repair applied before the extractor. One name per shape, so a report can say which. */
export type RepairKind = "positional_y"

/**
 * The shape: `{"x": 623, 884}` — the `"y":` key omitted, the value left in place. It is NOT valid
 * JSON, so `JhExtract` rejects the WHOLE reply and the observation, the prediction and the watch
 * region go with it, even though the coordinate inside is right.
 *
 * ⚠️ **Sticky (`y`), anchored at a `{` the caller has proven is outside a string.** A regex swept over
 * the raw reply would also match inside a model-authored `observation`, and silently rewriting text
 * the model read off an untrusted screen is a worse defect than the one being fixed.
 */
const POSITIONAL_Y = /\{\s*"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\}/y

/**
 * Supply the omitted `"y":` key, and **refuse everything else.**
 *
 * 🔴 **Measured, not imagined.** Across the 362 recorded planner/grounding replies of the §7c study
 * this is the ONLY malformed shape the floor model produces: a survey of every bare numeric literal
 * sitting in member position found **94 occurrences, all of them `keys=[x] bare=1`**, and it accounts
 * for **94 of the 104** replies the shipped parser rejected. The other 10 are truncated replies
 * (`unbalanced`), which stay rejected — a truncated reply is a *budget* reading, and inventing a
 * closing brace would be inventing an action.
 *
 * 🔴 **What this REFUSES to recover, deliberately — a guess about a coordinate is the failure
 * `coordinates.ts` argues must never be *usually* right:**
 * - **`{623, 884}`** — no `"x"` key. Which axis is which would be a guess, and the object must OPEN
 *   on `"x"`, so `{"a": 1, "x": 2, 3}` is refused too.
 * - **`{"x": 1, 2, 3}`** and **`{"x": 1, 2, "button": "left"}`** — the object must CLOSE on the bare
 *   number. Two bare values are not a point, and a bare value followed by more members means the
 *   model lost a key somewhere this rule cannot name.
 * - **`{"y": 884, 623}`** — the contract's order is x then y; a bare number after `"y"` is not a
 *   positional y, whatever it is.
 * - **anything inside a JSON string** — the scan is string- and escape-aware, so an `observation`
 *   quoting `{"x": 5, 6}` is left exactly as the model wrote it.
 * - **a reply that already parses** — {@link parseProposal} only reaches this on an `invalid_json`
 *   failure, so no well-formed reply is ever rewritten, and there is no regression surface at all.
 * - **a repair that does not then parse** — the caller keeps the ORIGINAL failure, so an error message
 *   can never describe text the model did not write.
 *
 * ⚠️ A positional ARRAY (`"point": [623, 884]`) is a different thing and was already accepted by
 * {@link coercePoint} before this existed: `[a, b]` is JSON that *means* an ordered pair, and reading
 * it in the contract's declared order is a convention, not a recovery.
 */
export function repairPositionalY(text: string): { readonly text: string; readonly repairs: number } {
  let out = ""
  let last = 0
  let repairs = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch !== "{") continue
    POSITIONAL_Y.lastIndex = i
    const match = POSITIONAL_Y.exec(text)
    if (match === null) continue
    out += `${text.slice(last, i)}{"x": ${match[1]}, "y": ${match[2]}}`
    last = i + match[0].length
    i = last - 1
    repairs += 1
  }
  return { text: repairs === 0 ? text : out + text.slice(last), repairs }
}

/**
 * Free-form reply → draft. Extract the JSON object out of whatever prose surrounds it, coerce the
 * known floor-model shapes, decode. **No structural validation** — same split as
 * `JhExpander.parseReply`, and for the same reason: the caller needs the draft to build a repair.
 *
 * ⚠️ **The extractor is `jh/extract.ts`, reused rather than rewritten.** It is a single-pass balanced
 * brace scanner that is string- and escape-aware, prefers the LAST fenced block, and repairs exactly
 * two things (trailing commas, invalid backslash escapes) while never eval-ing, JSON5-ing or
 * "healing" quotes. That behaviour was tuned against real qwen replies; a second copy here would be a
 * second opinion about the same model, and the weaker one.
 */
export function parseProposal(text: string): ParseResult {
  const first = JhExtract.extractJsonObject(text)
  // 🔴 The ONE named textual repair, and it is reached only after the extractor has already refused.
  // A well-formed reply never touches `repairPositionalY`, so this cannot change any reply that
  // works today; and if the repaired text still does not extract, the ORIGINAL failure is reported,
  // so the message never describes bytes the model did not write.
  let extracted = first
  const repairs: RepairKind[] = []
  if (!first.ok && first.failure.reason === "invalid_json") {
    const repaired = repairPositionalY(text)
    if (repaired.repairs > 0) {
      const retry = JhExtract.extractJsonObject(repaired.text)
      if (retry.ok) {
        extracted = retry
        repairs.push("positional_y")
      }
    }
  }
  if (!extracted.ok) {
    const f = extracted.failure
    const parts = [`${f.reason}: ${f.detail}`]
    if (f.position !== undefined) parts.push(`near position ${f.position}`)
    if (f.snippet) parts.push(`context: ${f.snippet}`)
    if (f.cause) parts.push(`likely cause: ${f.cause}`)
    return { ok: false, issue: parts.join(" — ") }
  }
  try {
    const draft = Schema.decodeUnknownSync(ProposalDraft)(coerceProposalShape(extracted.value))
    return repairs.length === 0 ? { ok: true, draft } : { ok: true, draft, repairs }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, issue: msg.replace(/\s+/g, " ").trim().slice(0, 300) }
  }
}

// ---------------------------------------------------------------------------------------------
// The contract, and the repair re-prompt
// ---------------------------------------------------------------------------------------------

/**
 * The schema as the model is told it, owned by the module that enforces it.
 *
 * ⚠️ **Same file as the validator ON PURPOSE.** A14.4 records what happens otherwise: MudrikNow's
 * grid described its geometry at the prompt site and drew it somewhere else, which cost ~324 px of
 * vertical error and made the bottom 45% of the screen unaddressable. A contract stated in one file
 * and checked in another drifts the same way, silently, and the symptom is a model that looks bad at
 * the task. `prompt.ts` (S3) renders these lines; it does not restate them.
 */
export const CONTRACT_LINES: ReadonlyArray<string> = [
  "Emit EXACTLY ONE ```json object. It must be one of these three shapes and nothing else:",
  '  ACT     {"observation": "<one line: what is on this screen>", "action": {"kind": "...", ...},',
  '           "expect": "<one short sentence: what the screen will look like AFTER this action>"}',
  '  ABSTAIN {"abstain": true, "reason": "<why you cannot act — e.g. the target is not visible>"}',
  '  DONE    {"claim_done": true, "evidence": "<what on this screen shows the task is finished>"}',
  "",
  `action.kind is one of: ${ACTION_KINDS.join(" | ")}. The harness takes the screenshots — never ask for one.`,
  '  move | click | double_click → "target": "<the control\'s visible LABEL, nothing else>"',
  '                                  (click also takes "button")',
  '  type → "text"      type_submit → "text"      key → "keys"      scroll → "direction" + "amount"',
  "  type_submit types the text and presses Return as ONE semantic action.",
  "",
  "`expect` is REQUIRED on every action. It is checked against the next screenshot by a separate",
  "reader who is shown only that screenshot and your sentence — so write what will be VISIBLE, not",
  "what you intended. A prediction that cannot be seen cannot be confirmed.",
  "",
  `For ${POINTER_KINDS.join(" / ")}, never emit a point, coordinates, or watch region. The harness`,
  "grounds the visible label in a separate blind call and derives the watched pixels itself.",
  "",
  "Abstaining is a legal, correct answer. If you cannot see the target, say so — a wrong click costs",
  "more than a skipped turn.",
]

const MESSAGE: Record<IssueCode, string> = {
  no_proposal: "the reply is not one of the three legal shapes",
  ambiguous_shape:
    "the reply mixes two shapes — emit ONE. A `claim_done` is judged against the screen as it is NOW, so it cannot ride along with an action that has not happened yet",
  missing_expect: "`expect` is missing: every action must predict what the screen will look like afterwards",
  missing_observation: "`observation` is missing: describe what you see before deciding what to do",
  unknown_action_kind: `not an action this harness can perform — use one of: ${ACTION_KINDS.join(" | ")}`,
  harness_owned_action: "the harness takes the screenshots; propose an action that changes the screen",
  pointer_missing_target: "this pointer action needs `action.target`: the control's visible label and nothing else",
  planner_grounding_fields:
    "do not emit coordinates or a watch region — the harness uses a separate blind grounder and derives the watched pixels",
  missing_action_payload: "this action kind needs that field",
  abstain_missing_reason: "say WHY you are abstaining — the reason is what the next step is planned from",
  claim_done_missing_evidence: "say what on the screen shows the task is finished",
}

/** One rendered line per issue: `expect — …` / `watch (…) — …`. */
export const describeIssue = (issue: StructuralIssue): string => {
  const where = issue.path === "" ? "" : issue.path
  const detail = issue.detail === undefined ? "" : ` (${issue.detail})`
  return `${where}${detail}${where === "" && detail === "" ? "" : ": "}${MESSAGE[issue.code]}`
}

/**
 * The ONE repair re-prompt. G3: the model gets a single chance to fix its own reply; after that the
 * retry costs budget like any other step, because an unbounded repair loop is a budget leak dressed
 * as robustness.
 *
 * Returns `""` when there is nothing to repair, so a caller cannot accidentally send an empty
 * complaint — `if (text) ask(text)` is the whole call site.
 *
 * ⚠️ **It restates the contract, deliberately.** The failure being repaired is usually that the model
 * did not follow the schema, and answering with only a list of complaints asks it to remember the
 * thing it just demonstrated it had lost.
 */
export function repairPrompt(input: {
  readonly parseFailure?: string
  readonly issues?: ReadonlyArray<StructuralIssue>
}): string {
  const issues = input.issues ?? []
  const errors = errorsOf(issues)
  const warnings = issues.filter((i) => i.severity === "warning")
  if (input.parseFailure === undefined && errors.length === 0) return ""

  const lines: string[] = ["The harness REJECTED your last reply."]
  if (input.parseFailure !== undefined) {
    lines.push(`  - it could not be read as JSON — ${input.parseFailure}`)
  }
  for (const issue of errors) lines.push(`  - ${describeIssue(issue)}`)
  if (errors.length > 0 && warnings.length > 0) lines.push("Also worth fixing while you are here:")
  for (const issue of warnings) lines.push(`  - ${describeIssue(issue)}`)
  lines.push("", "Re-emit the WHOLE proposal, corrected.", "", ...CONTRACT_LINES)
  return lines.join("\n")
}
