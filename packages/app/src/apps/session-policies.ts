import { authorText } from "./skills"

// What a pre-action POLICY did to this chat's tool calls, in the words a person acts on.
//
// ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// `todo/projects.md` → *Typed pre-action policies*: *"bind every intervention to a receipt."* The
// kernel keeps that promise twice — a durable `session_policy_decision` row, and a sentence
// prepended to the tool's own result so the MODEL is not lied to. Neither of those is a surface a
// person looks at. Until this module existed an installed policy could rewrite a `bash` command,
// record it perfectly, tell the model, and never tell the human — which is the product rewriting a
// tool call and keeping it to itself.
//
// ─── THE FRAMING RULE, AND IT IS THE SAME ONE THE SKILLS APP KEEPS ────────────────────────────────
// Every string here except the timestamp is DATA, not our claim. A policy's `id`, its `describe`,
// the composed `detail` and each provider's own `detail` come from whichever provider was
// installed. Today that is only NovaClaw's two built-ins, but `ToolPolicy.Provider` is the same
// interface a plugin implements, so this module is written as if a stranger authored every one of
// them:
//   1. Author strings go through `authorText` — imported from `./skills` rather than copied,
//      because "a string that lies about how it renders" has one correct answer and two copies of
//      it drift. It strips the bidi/invisible characters and bounds the length.
//   2. An unfamiliar `decision` word is reported as unfamiliar. It is NOT folded into the nearest
//      verdict this build knows: a receipt row outlives the build that wrote it, and guessing that
//      an unknown outcome means "allowed" is exactly the direction that turns a refusal into a
//      reassuring sentence.
//   3. Nothing here decides whether an intervention was RIGHT. It reports what happened and who
//      did it, with the ids intact so a reader can go and look.

/** The wire row (`SessionReceipt.PolicyDecision`), as `GET /api/session/:id/receipt` sends it. */
export interface PolicyDecisionInfo {
  readonly toolCallID: string
  readonly tool: string
  readonly decision: string
  readonly detail: string
  readonly providers: readonly { readonly id: string; readonly outcome: string; readonly detail?: string }[]
  readonly patched?: Readonly<Record<string, unknown>>
  readonly at: number
}

/** One installed policy, as the instance reports it. Used only to resolve ids the receipt names. */
export interface InstalledPolicy {
  readonly id: string
  readonly describe: string
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The kernel's vocabulary, mirrored — plus the arm the kernel cannot produce
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `ToolPolicy.RANK`'s six outcomes, and `unknown` for a word this build has never heard of.
 *
 * ⚠️ `unknown` is not a defensive nicety. Rows are durable and a newer NovaClaw may add a seventh
 * outcome; a decision this build cannot name must read as *"a newer NovaClaw recorded something
 * this one cannot name"* rather than being silently sorted under `allow`.
 */
export type Outcome = "allow" | "context" | "patch" | "approve" | "deny" | "halt" | "unknown"

const KNOWN: readonly Outcome[] = ["allow", "context", "patch", "approve", "deny", "halt"]

export function outcomeOf(decision: string): Outcome {
  return (KNOWN as readonly string[]).includes(decision) ? (decision as Outcome) : "unknown"
}

/**
 * Did the tool call actually run?
 *
 * 🔴 Three answers, not two. `deny` and `halt` prevented it; `allow`/`context`/`patch` did not; an
 * `approve` row is only ever written as `approve` once the human granted it (a refused approval is
 * re-recorded as `deny` by the gate), so it ran. `undefined` is the honest answer for a word we do
 * not know — and it is a different sentence from "it was blocked", which is what a reader would be
 * told if this returned a boolean.
 */
export function didRun(outcome: Outcome): boolean | undefined {
  if (outcome === "deny" || outcome === "halt") return false
  if (outcome === "unknown") return undefined
  return true
}

/**
 * What one provider did, in the four groups a reader needs.
 *
 * `unavailable` is its own group and must never be collapsed into `refused`: the gate records a
 * provider that timed out or died AS unavailable, precisely so a wedged advisor is distinguishable
 * from one that deliberately said no. The composed verdict may still be a refusal — that is the
 * fail-closed rule doing its job — but the reason a person acts on is different.
 */
export type ProviderRole = "silent" | "intervened" | "refused" | "unavailable" | "unknown"

export function providerRole(outcome: string): ProviderRole {
  switch (outcome) {
    case "allow":
      return "silent"
    case "context":
    case "patch":
    case "approve":
      return "intervened"
    case "deny":
    case "halt":
      return "refused"
    case "timed-out":
    case "errored":
      return "unavailable"
    default:
      return "unknown"
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Rendering a value a policy replaced
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One replaced field, as text.
 *
 * ⚠️ `patched` is `Record<string, unknown>` on the wire because a policy may rewrite ANY tool's
 * arguments, so the value can be a string, a number, an object or an array. A string is shown as
 * itself (that is what a rewritten `command` is); everything else is JSON, because inventing a
 * prose rendering for an arbitrary object would be this surface making a claim about a value it
 * cannot read.
 *
 * ⚠️ It is put through `authorText` AFTER stringifying, not before: a policy-supplied value is
 * author text exactly like the prose is, and a rewritten command containing a bidi override would
 * otherwise render as something other than what will run.
 */
export function describeValue(value: unknown, max = 400): string {
  if (typeof value === "string") return authorText(value, max)
  if (value === undefined) return authorText("undefined", max)
  try {
    return authorText(JSON.stringify(value) ?? String(value), max)
  } catch {
    return authorText(String(value), max)
  }
}

export interface PatchedField {
  readonly field: string
  readonly value: string
}

export function patchedFields(patched: Readonly<Record<string, unknown>> | undefined): PatchedField[] {
  if (!patched) return []
  // Sorted by field name: the wire order is `Object.keys` over a JSON object, which is insertion
  // order and therefore an accident of which policy answered first. A person comparing two runs of
  // the same call must not see the rows move.
  return Object.keys(patched)
    .toSorted()
    .map((field) => ({ field: authorText(field, 80) || field, value: describeValue(patched[field]) }))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The rows the page renders
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProviderView {
  /** The id as shown. Sanitized, and never empty — an unnamed policy row is worse than a labelled one. */
  readonly id: string
  /** The id verbatim, for keys and for anything that has to match the installed list. */
  readonly rawID: string
  /** What this provider answered, verbatim — including `timed-out` / `errored`. */
  readonly outcome: string
  readonly role: ProviderRole
  /** This provider's own sentence, or `""`. */
  readonly detail: string
  /**
   * Whether this id is installed in THIS NovaClaw right now.
   *
   * ⚠️ `undefined` when we were not able to read the installed list at all — which is a different
   * claim from "not installed", and a surface that spelled them the same would accuse a policy of
   * having vanished every time a request failed.
   */
  readonly installed: boolean | undefined
  /** What the installed policy says it does, when we can resolve it. `""` otherwise. */
  readonly describe: string
}

export interface InterventionView {
  /** Stable across re-fetches: the call and the tool, which is exactly the receipt row's own key. */
  readonly key: string
  readonly toolCallID: string
  /** The tool name as the model called it. Author text — an MCP server names its own tools. */
  readonly tool: string
  readonly outcome: Outcome
  /** The `decision` word verbatim, so an `unknown` arm can still say WHAT it could not name. */
  readonly rawDecision: string
  /** The composed sentence the model was given. The same words, so the two readers agree. */
  readonly detail: string
  /** `true` ran · `false` prevented · `undefined` we cannot tell (an outcome word we do not know). */
  readonly ran: boolean | undefined
  readonly patched: readonly PatchedField[]
  /** Every consulted policy, in the order the receipt sorted them (policy id). */
  readonly providers: readonly ProviderView[]
  /**
   * The ids that did something — the answer to "who did this to my tool call".
   *
   * ⚠️ These four lists carry the ids VERBATIM, because they are the value a reader may have to
   * match against a `novaclaw.json` or a Settings row. A surface putting one on screen renders it
   * through {@link displayID} (or `authorText`) like every other author string — the raw form is
   * kept here so the two uses do not have to share one compromise.
   */
  readonly actedBy: readonly string[]
  /** The ids that were consulted and said nothing. The answer to "was the guard even running". */
  readonly silent: readonly string[]
  /** The ids that failed to answer at all. */
  readonly unavailable: readonly string[]
  /** The ids this NovaClaw has no policy for. Empty when the installed list is unknown. */
  readonly unresolved: readonly string[]
  readonly at: number
}

export function toIntervention(
  row: PolicyDecisionInfo,
  installed?: readonly InstalledPolicy[],
): InterventionView {
  const index = installed && new Map(installed.map((entry) => [entry.id, entry] as const))
  const outcome = outcomeOf(row.decision)
  const providers = row.providers.map((entry): ProviderView => {
    const known = index?.get(entry.id)
    return {
      id: authorText(entry.id, 80) || "(unnamed policy)",
      rawID: entry.id,
      outcome: entry.outcome,
      role: providerRole(entry.outcome),
      detail: authorText(entry.detail, 400),
      // ⚠️ `undefined` rather than `false` when the list was never fetched — see the field's note.
      installed: index === undefined ? undefined : index.has(entry.id),
      describe: authorText(known?.describe, 240),
    }
  })
  return {
    key: `${row.toolCallID} ${row.tool}`,
    toolCallID: row.toolCallID,
    tool: authorText(row.tool, 80) || "(unnamed tool)",
    outcome,
    rawDecision: authorText(row.decision, 40),
    detail: authorText(row.detail, 1200),
    ran: didRun(outcome),
    patched: patchedFields(row.patched),
    providers,
    actedBy: providers.filter((p) => p.role === "intervened" || p.role === "refused").map((p) => p.rawID),
    silent: providers.filter((p) => p.role === "silent").map((p) => p.rawID),
    unavailable: providers.filter((p) => p.role === "unavailable").map((p) => p.rawID),
    unresolved: providers.filter((p) => p.installed === false).map((p) => p.rawID),
    at: row.at,
  }
}

/**
 * Newest first.
 *
 * The receipt sends them oldest-first (the composer orders by `time_created`), which is the right
 * order for evidence and the wrong one for a panel: the intervention a person came to look at is
 * the one that just happened. Ties fall back to the key so the order is total — two decisions can
 * share a millisecond, and a list that reshuffles on every re-fetch reads as a bug.
 */
export function sortInterventions(views: readonly InterventionView[]): InterventionView[] {
  return [...views].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
}

export function toInterventions(
  rows: readonly PolicyDecisionInfo[],
  installed?: readonly InstalledPolicy[],
): InterventionView[] {
  return sortInterventions(rows.map((row) => toIntervention(row, installed)))
}

/**
 * The one-line answer for the section header.
 *
 * 🔴 `total === 0` is a POSITIVE statement and the copy must say so: a row exists only where
 * something happened, so an empty list means every installed policy allowed every call in this
 * attempt, in time. Hiding the section when it is empty would trade that sentence for silence, and
 * silence is what this whole feature exists to stop.
 */
export interface Summary {
  readonly total: number
  /** How many calls were prevented (`deny` or `halt`). */
  readonly prevented: number
  /** How many ran with their arguments rewritten. */
  readonly rewritten: number
  /** How many were held for a human and approved. */
  readonly approved: number
  /** How many only added a note for the model. */
  readonly annotated: number
  /** How many carry a `decision` word this build cannot name. */
  readonly unnamed: number
  /** How many rows mention a policy id this NovaClaw does not have installed. */
  readonly withUnresolved: number
  /** How many rows mention a policy that failed to answer. */
  readonly withUnavailable: number
}

export function summarize(views: readonly InterventionView[]): Summary {
  return {
    total: views.length,
    prevented: views.filter((view) => view.outcome === "deny" || view.outcome === "halt").length,
    rewritten: views.filter((view) => view.outcome === "patch").length,
    approved: views.filter((view) => view.outcome === "approve").length,
    // `allow` lands here too, and deliberately: the gate writes an `allow` row ONLY when a provider
    // failed to answer, so it is never "nothing happened" — it is "the call ran and not every
    // policy answered", which is the same shape of fact as a context note.
    annotated: views.filter((view) => view.outcome === "context" || view.outcome === "allow").length,
    unnamed: views.filter((view) => view.outcome === "unknown").length,
    withUnresolved: views.filter((view) => view.unresolved.length > 0).length,
    withUnavailable: views.filter((view) => view.unavailable.length > 0).length,
  }
}
