export * as ToolPolicy from "./tool-policy"

import { createHash } from "node:crypto"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { Duration, Effect, Schema } from "effect"

/**
 * ─── TYPED PRE-ACTION POLICIES: the vocabulary and the composition ─────────────────────────────
 *
 * The adopted product idea, in full: *"before tool execution, installed policy
 * providers may return a typed allow, deny, input patch, context addition, approval request, or
 * halt. Compose deterministically, make deny win, bind every intervention to a receipt, and fail
 * closed for safety-critical timeouts. `novaclaw.json` may configure policy IDs but may never
 * contain or auto-run shell commands."*
 *
 * This module is the PURE half — the six outcomes, the order they compose in, and the merge. It
 * holds no services and performs no I/O, which is what lets the determinism claim be tested as a
 * property of a function rather than of a run. `tool-policy-gate.ts` is the seam that consults the
 * installed providers, spends the approval, writes the receipt and applies the result;
 * `tool-policy-builtin.ts` is the one shipped provider.
 *
 * ── WHERE THE SEAM IS, AND WHY THERE ───────────────────────────────────────────────────────────
 *
 * Underneath every tool, at `ToolRegistry`'s `settleRaw` — the one function every tool call funnels
 * through (core tools, application tools, MCP/plugin tools, and the deferred dispatcher's nested
 * invocations all reach it). The reasoning is `project-exclusion.ts`'s, restated one layer up: a
 * guard placed BELOW all tools is inherited by a tool added later, while a guard sprinkled per-tool
 * is a checklist somebody eventually forgets. The difference is that exclusions gate a PATH, so
 * their seam is `LocationMutation.resolve`; a policy gates a CALL — a tool name plus its arguments —
 * so its seam is the call dispatcher.
 *
 * ── THE SIX OUTCOMES, AND WHY TWO OF THEM ARE NOT VERDICTS ─────────────────────────────────────
 *
 * `allow`, `approve`, `deny` and `halt` answer *may this call run*. `patch` and `context` do not:
 * a provider returning either has said "yes, and…" — it is not withholding the call, it is changing
 * what runs or what the model is told about it. Treating all six as one lattice would mean a patch
 * outranking an approval request (so the arguments get rewritten and the human is never asked) or
 * an approval request discarding a patch (so the human approves the call the model wrote, and the
 * patched one runs). Both are wrong, and both look right in a one-line `Math.max`.
 *
 * So composition has two parts, and each is order-independent on its own:
 *
 *  1. **The VERDICT** is the maximum over {@link RANK} — a total order on the six. `patch` and
 *     `context` map onto it too, because the DECISION's own name has to report the strongest thing
 *     that happened to the call; they simply never withhold it.
 *  2. **The MODIFIERS** — every patch and every context note — accumulate across providers and are
 *     carried by the decision. They apply if and only if the verdict lets the call run.
 *
 * ── THE ORDER, WRITTEN DOWN (the item asks for it explicitly) ──────────────────────────────────
 *
 *      allow  <  context  <  patch  <  approve  <  deny  <  halt
 *
 * · **`deny` beats `allow`, `context`, `patch` and `approve`** — the item's *"make deny win"*. No
 *   outcome that would let the call proceed can override a refusal, whatever order the providers
 *   were installed in or finished in. This is the clause that matters, and it is pinned one test
 *   per losing outcome.
 * · **`halt` beats `deny`, and this is the one place the answer was open.** Both prevent the call,
 *   so neither weakens the other about THIS call; they differ in what happens next, and `halt`
 *   prevents strictly more (this call *and* the rest of the drain). Composition must never resolve
 *   a disagreement by discarding the stronger prevention — choosing `deny` here would be the only
 *   direction in which composing two refusals produces something weaker than one of them. Note what
 *   this does NOT do: it never converts a permissive outcome into a stop, because `halt` only wins
 *   when a provider actually returned one.
 * · **`approve` beats `patch` and `context`** — an approval request withholds the call, and a
 *   modifier does not. The patch is not lost: it is carried and applied if the human approves, which
 *   is also the only honest thing to show them (see the gate's approval metadata).
 * · **`patch` beats `context`** — both are modifiers and both are kept; the ordering only decides
 *   what the decision is CALLED, and "an argument was rewritten" is the fact a reader must not have
 *   to dig for.
 *
 * ── TWO PATCHES ON ONE FIELD: REFUSED, NOT ORDERED ─────────────────────────────────────────────
 *
 * When two providers replace the same field with different values, the composed decision becomes a
 * `deny` naming both policies. The alternative — order by policy id and let the later win — makes
 * the executed arguments depend on a lexical accident neither policy author knows about, and the
 * losing policy would have been told its intervention applied when it did not. The product would
 * then run a call that no policy asked for, which is the same class of lie the receipt exists to
 * prevent. Identical values are not a conflict: two policies agreeing is not an ambiguity.
 *
 * A patch is a TOP-LEVEL field replace, deliberately, for `ProjectFile.merge`'s reason: a deep
 * merge cannot distinguish "leave this alone" from "empty this list", and a policy holding half a
 * nested object is a policy that cannot say which it meant.
 */

/** How restrictive an outcome is. The total order the header specifies; higher wins. */
export const RANK = { allow: 0, context: 1, patch: 2, approve: 3, deny: 4, halt: 5 } as const

export type OutcomeType = keyof typeof RANK

/** The outcome types, most permissive first — for tests and for anything enumerating the vocabulary. */
export const OUTCOME_TYPES = ["allow", "context", "patch", "approve", "deny", "halt"] as const

type OutcomeTypesMatchRank = [OutcomeType] extends [(typeof OUTCOME_TYPES)[number]]
  ? [(typeof OUTCOME_TYPES)[number]] extends [OutcomeType]
    ? true
    : ["OUTCOME_TYPES has entries RANK does not", Exclude<(typeof OUTCOME_TYPES)[number], OutcomeType>]
  : ["OUTCOME_TYPES is missing", Exclude<OutcomeType, (typeof OUTCOME_TYPES)[number]>]
const _outcomeTypesMatchRank: OutcomeTypesMatchRank = true
void _outcomeTypesMatchRank

/**
 * What one provider answers for one call.
 *
 * ⚠️ **One outcome per provider per call, not a list.** A provider that wants to both rewrite an
 * argument and explain itself puts the explanation in the patch's `reason` — which is where the
 * receipt and the model-facing note read it from anyway. Allowing a list would make a provider's own
 * answer need an internal composition rule, and there would then be two of them.
 */
export type Outcome =
  /** Nothing to say. The common answer, and the only one that costs nothing. */
  | { readonly type: "allow" }
  /** Put this sentence in front of the model with the tool's result. The call runs unchanged. */
  | { readonly type: "context"; readonly text: string }
  /**
   * Replace these TOP-LEVEL fields of the tool's input. `reason` is model-facing and mandatory:
   * a rewrite the model is not told about is the defect the receipt clause names.
   */
  | { readonly type: "patch"; readonly fields: Readonly<Record<string, unknown>>; readonly reason: string }
  /**
   * Ask the human first. Spent through the EXISTING permission ask (`PermissionV2.assert` with
   * `minimumEffect: "ask"`), never a parallel approval mechanism — see the gate.
   */
  | {
      readonly type: "approve"
      /** The permission action to ask under. A user's saved answer is keyed on it. */
      readonly action: string
      /** What is being approved, in the vocabulary a consent card shows. */
      readonly resources: readonly string[]
      /** The broader patterns an "always" answer should save; omitted means the card is once-only. */
      readonly save?: readonly string[]
      readonly reason: string
    }
  /** Refuse this call. The session continues and the model may route around it. */
  | { readonly type: "deny"; readonly reason: string }
  /** Refuse this call AND stop the drain. Strictly more than a deny; see the header. */
  | { readonly type: "halt"; readonly reason: string }

/** What a provider is asked about. Everything a policy may see, and nothing it may mutate. */
export interface Request {
  readonly sessionID: string
  readonly agent: string
  /** The registered tool name, exactly as the model called it. */
  readonly tool: string
  readonly toolCallID: string
  /** The decoded call arguments, before any patch. Non-object inputs arrive as an empty record. */
  readonly input: Readonly<Record<string, unknown>>
  /** The session's working folder — the folder whose `novaclaw.json` selected the opt-in policies. */
  readonly directory: string
}

/**
 * One installed policy.
 *
 * ⚠️ `evaluate` takes no services in its signature (`R = never`). A provider that needs one captures
 * it at layer build, exactly as every tool module does — the point is that a provider cannot acquire
 * a capability at call time, so the cost of consulting it is bounded by what it closed over.
 */
export interface Provider {
  /** Matches {@link ProjectFile.POLICY_ID_PATTERN}; a registration with any other shape is refused. */
  readonly id: string
  /** One line, for the receipt and for any surface listing what is installed. */
  readonly describe: string
  /**
   * Whether this policy runs without a `novaclaw.json` naming it.
   *
   * 🔴 Defaults to `true`, and the default is the safe direction, the same way
   * `LocationMutation.ResolveInput.readsContent` defaults to "this reads": an operator who installed
   * a guard installed it to run. `false` marks a policy a FOLDER opts into, which is the only thing
   * a project file's `policies` list can do — it can turn an installed opt-in policy ON for its own
   * folder, and it can never turn an always-on one off. A project may only narrow, here as
   * everywhere else.
   */
  readonly alwaysOn?: boolean
  /**
   * Whether a failure to answer must fail CLOSED.
   *
   * 🔴 Defaults to `true` — the item's *"fail closed for safety-critical timeouts"*, in the
   * fail-closed direction for a provider that forgot to classify itself. A provider that times out,
   * throws, or dies is a provider whose opinion we do not have; treating that as `allow` would make
   * the way to defeat a safety policy *"make it slow"*. Opting out with `false` is for an ADVISORY
   * policy — one whose whole output is a context note — where failing closed would let an unrelated
   * hung advisor refuse every tool call in the instance.
   */
  readonly safetyCritical?: boolean
  readonly evaluate: (request: Request) => Effect.Effect<Outcome>
}

export const alwaysOn = (provider: Provider) => provider.alwaysOn !== false
export const safetyCritical = (provider: Provider) => provider.safetyCritical !== false

/**
 * How long ONE provider gets to answer, before it is treated as not having answered.
 *
 * ── THE NUMBER, DERIVED RATHER THAN BORROWED ───────────────────────────────────────────────────
 *
 * ⚠️ *A threshold that fires on normal traffic is not a threshold*, so the healthy distribution came
 * first. A provider is a function over a tool name and its already-decoded arguments; the shipped
 * one is a set of regular expressions over a command string. Measured on this laptop
 * (`test/tool-policy.test.ts` → *"the budget is UNREACHABLE by normal traffic"*, which fails if this
 * stops being true — 0.0145 ms/call re-measured 2026-08-19): the shipped provider
 * answers a worst-case call in well under a millisecond, and the whole gate — cache read, project
 * resolution, every provider, composition — is a small number of milliseconds. A provider that read
 * a file or ran one SQLite query would still be inside single-digit milliseconds.
 *
 * **Five seconds** is therefore some three orders of magnitude above anything healthy, which is the
 * margin a fail-closed threshold needs: the cost of firing early is a refused tool call on a healthy
 * instance, and there is no amount of "probably fine" that makes that acceptable. It is also short
 * enough that a wedged provider reads as a refusal rather than as a hung model — the gate runs
 * before every tool call, so this bound IS the worst-case latency a broken policy can add to a turn.
 *
 * ⚠️ Deliberately NOT copied from the provider-stream watchdog or the quality-check timeout. Those
 * bound a subprocess and a network stream — work whose healthy case is seconds — and a number that
 * transfers by resemblance rather than by measurement is how a threshold ends up unable to fire.
 */
export const PROVIDER_BUDGET = Duration.seconds(5)

/** How a provider failed to answer. Both fail closed for a safety-critical provider. */
export type Unavailability = "timed-out" | "errored"

/** One provider's contribution, after the budget has been applied. */
export type Result =
  | { readonly id: string; readonly kind: "answered"; readonly outcome: Outcome; readonly safetyCritical: boolean }
  | { readonly id: string; readonly kind: Unavailability; readonly safetyCritical: boolean }

/** What the composed decision instructs the seam to do. */
export interface Decision {
  /** The verdict's name — the maximum over {@link RANK}. */
  readonly type: OutcomeType
  /** One sentence, model-facing. Every refusal and every intervention can name itself. */
  readonly detail: string
  /** The top-level input fields to replace. Empty when nothing was patched. */
  readonly patch: Readonly<Record<string, unknown>>
  /** Context notes, in policy-id order. */
  readonly notes: readonly string[]
  /** Approval requests to spend before the call may run, in policy-id order. */
  readonly approvals: readonly {
    readonly id: string
    readonly action: string
    readonly resources: readonly string[]
    readonly save?: readonly string[]
    readonly reason: string
  }[]
  /** Every consulted provider and what it answered, in policy-id order — the receipt's `providers`. */
  readonly providers: readonly { readonly id: string; readonly outcome: string; readonly detail?: string }[]
}

const unavailabilityDetail = (result: Result & { readonly kind: Unavailability }) =>
  result.kind === "timed-out"
    ? `the policy \`${result.id}\` did not answer within ${Duration.toSeconds(PROVIDER_BUDGET)} seconds`
    : `the policy \`${result.id}\` failed while deciding`

/**
 * Compose every provider's contribution into ONE decision.
 *
 * 🔴 **Order-independent by construction, which is what "deterministic" has to mean here.** The
 * inputs are sorted by policy id before anything reads them, the verdict is a maximum (commutative
 * and associative), the notes and approvals are emitted in that same sorted order, and the patch
 * merge either has disjoint keys (order cannot matter) or has a conflict (which is a property of the
 * SET, so it is found whichever way round the pair arrives). Nothing here can observe which provider
 * finished first — the gate hands in results, never promises.
 */
export function compose(results: readonly Result[]): Decision {
  const sorted = [...results].toSorted((a, b) => a.id.localeCompare(b.id))

  // A provider that could not answer becomes a deny if it is safety-critical, and contributes
  // nothing at all otherwise. Done first, so everything below sees one uniform vocabulary.
  const contributions = sorted.map((result) =>
    result.kind === "answered"
      ? { id: result.id, outcome: result.outcome, unavailable: undefined }
      : {
          id: result.id,
          outcome: (result.safetyCritical
            ? { type: "deny", reason: unavailabilityDetail(result) }
            : { type: "allow" }) satisfies Outcome as Outcome,
          unavailable: result.kind,
        },
  )

  const providers = contributions.map((entry) => ({
    id: entry.id,
    // The receipt records what the provider DID, so an unavailable provider is recorded as
    // unavailable rather than as the deny it was converted into. Collapsing the two would make a
    // wedged advisory policy indistinguishable from one that deliberately refused.
    outcome: entry.unavailable ?? entry.outcome.type,
    ...(detailOf(entry.outcome) === undefined ? {} : { detail: detailOf(entry.outcome)! }),
  }))

  let verdict: OutcomeType = "allow"
  const notes: string[] = []
  const approvals: Array<Decision["approvals"][number]> = []
  const patch: Record<string, unknown> = {}
  // Which policy last set each field, so a conflict can name BOTH sides rather than only the loser.
  const patchedBy = new Map<string, string>()
  const conflicts: string[] = []
  const refusals: string[] = []

  for (const { id, outcome } of contributions) {
    if (RANK[outcome.type] > RANK[verdict]) verdict = outcome.type
    switch (outcome.type) {
      case "allow":
        break
      case "context":
        notes.push(`[policy ${id}] ${outcome.text}`)
        break
      case "patch":
        notes.push(`[policy ${id}] ${outcome.reason}`)
        for (const [key, value] of Object.entries(outcome.fields)) {
          const owner = patchedBy.get(key)
          if (owner !== undefined && !sameValue(patch[key], value)) {
            conflicts.push(
              `\`${key}\` is claimed by both \`${owner}\` and \`${id}\`, with different values`,
            )
            continue
          }
          patch[key] = value
          patchedBy.set(key, owner ?? id)
        }
        break
      case "approve":
        approvals.push({
          id,
          action: outcome.action,
          resources: outcome.resources,
          ...(outcome.save === undefined ? {} : { save: outcome.save }),
          reason: outcome.reason,
        })
        break
      case "deny":
      case "halt":
        refusals.push(`\`${id}\`: ${outcome.reason}`)
        break
    }
  }

  // A conflict escalates to a refusal, and it escalates only from BELOW — a decision already at
  // `deny` or `halt` is not weakened, and one already at `approve` becomes the refusal rather than
  // asking a human to approve arguments we cannot determine.
  if (conflicts.length > 0 && RANK[verdict] < RANK.deny) {
    return {
      type: "deny",
      detail:
        `Two installed policies disagree about how to rewrite this call, so nothing ran: ` +
        `${conflicts.join("; ")}. This is refused rather than resolved by an ordering rule, because ` +
        `running arguments neither policy asked for would be worse than running none.`,
      patch: {},
      notes,
      approvals: [],
      providers,
    }
  }

  return {
    type: verdict,
    detail: detailFor(verdict, { refusals, approvals, notes, patch }),
    patch: verdict === "deny" || verdict === "halt" ? {} : patch,
    notes,
    approvals: verdict === "deny" || verdict === "halt" ? [] : approvals,
    providers,
  }
}

function detailOf(outcome: Outcome): string | undefined {
  switch (outcome.type) {
    case "allow":
      return undefined
    case "context":
      return outcome.text
    case "patch":
    case "deny":
    case "halt":
      return outcome.reason
    case "approve":
      return outcome.reason
  }
}

function detailFor(
  verdict: OutcomeType,
  parts: {
    readonly refusals: readonly string[]
    readonly approvals: Decision["approvals"]
    readonly notes: readonly string[]
    readonly patch: Readonly<Record<string, unknown>>
  },
): string {
  switch (verdict) {
    case "halt":
      return `Stopped by an installed policy before this call ran — ${parts.refusals.join("; ")}.`
    case "deny":
      return `Refused by an installed policy before this call ran — ${parts.refusals.join("; ")}.`
    case "approve":
      return `Held for your approval by an installed policy — ${parts.approvals
        .map((approval) => `\`${approval.id}\`: ${approval.reason}`)
        .join("; ")}.`
    case "patch":
      return `An installed policy rewrote ${Object.keys(parts.patch)
        .toSorted()
        .map((key) => `\`${key}\``)
        .join(", ")} before this call ran — ${parts.notes.join(" ")}`
    case "context":
      return parts.notes.join(" ")
    case "allow":
      return "Every installed policy allowed this call."
  }
}

/**
 * Value equality for the conflict test.
 *
 * ⚠️ Structural, not referential, and it goes through JSON because a tool's arguments are already
 * JSON — they arrived decoded from the provider's wire. Two policies that independently computed
 * the same replacement are agreeing, and calling that a conflict would refuse a call for a reason
 * nobody could act on.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/** Apply a composed patch to a tool call's arguments. Top-level replace; see the header. */
export function applyPatch(
  input: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...input, ...patch }
}

/**
 * A stable id for one decision, so a re-driven call updates its receipt rather than doubling it.
 *
 * ⚠️ `tool` is in the key, and it has to be: the deferred dispatcher invokes a nested tool under the
 * SAME provider call id (`registry.ts` reuses `input.call.id`), so keying on the call alone would
 * make the inner decision overwrite the outer one.
 */
export const decisionID = (sessionID: string, toolCallID: string, tool: string) =>
  "pol_" + createHash("sha256").update(`${sessionID}\n${toolCallID}\n${tool}`).digest("hex").slice(0, 24)

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("ToolPolicy.RegistrationError", {
  id: Schema.String,
  message: Schema.String,
}) {}

/**
 * The check every registration runs: a legal id, and no second policy under that id.
 *
 * The grammar is `@novaclaw/schema/project-file`'s `PolicyID` — the SAME one a `novaclaw.json` is
 * decoded against — rather than a second copy here. If the two could drift, a project could name an
 * id no provider is able to register under, or a provider could register under an id no project can
 * spell, and either way the "not installed" refusal below would fire for a reason nobody could see.
 */
export const validateRegistration = (id: string, installed: ReadonlySet<string>): Effect.Effect<void, RegistrationError> => {
  if (!ProjectFile.POLICY_ID_PATTERN.test(id))
    return Effect.fail(
      new RegistrationError({
        id,
        message:
          `"${id}" is not a legal policy id. An id is 1-64 characters of lowercase letters, digits, ` +
          `'-' and '.', with no leading or trailing separator — the same grammar a novaclaw.json is ` +
          `decoded against, so that a project can always spell the policies that are installed.`,
      }),
    )
  if (installed.has(id))
    return Effect.fail(
      new RegistrationError({
        id,
        message:
          `A policy is already installed under the id "${id}". Ids are how a novaclaw.json names a ` +
          `policy and how a receipt attributes an intervention; two providers sharing one would make ` +
          `both unattributable.`,
      }),
    )
  return Effect.void
}

/** One document's `config.tool_policy` section: a sparse map of switches, keyed by policy id. */
export type SwitchDeclaration = Readonly<Record<string, { readonly enabled?: boolean } | undefined>>

/**
 * Fold the config documents' `tool_policy` sections into the set of ids that are switched OFF.
 *
 * Pure, and exported, for one reason: **the fold is last-writer-wins in BOTH directions and the
 * layered case cannot be reached through the real `Config` layer today** — there is exactly one
 * synthetic settings document, so a gate test can never make a later document overturn an earlier
 * one. Leaving that branch inside the gate would make it code whose only justification is a comment;
 * here it is a function with a test.
 *
 * ⚠️ `enabled: true` DELETES rather than being ignored. A switch that only worked in the disabling
 * direction is a one-way door: the later document could turn a guard off and never back on, which is
 * the opposite of how every other sparse settings map in this repo resolves.
 *
 * ⚠️ Ids are taken verbatim and are NOT validated against {@link ProjectFile.POLICY_ID_PATTERN}. A
 * stored switch for an id no provider registered is inert by construction (nothing looks it up), and
 * refusing to decode the whole section because of one stale row would let a removed plugin brick the
 * switch for every policy beside it.
 */
export function disabledPolicies(declarations: readonly (SwitchDeclaration | undefined)[]): Set<string> {
  const off = new Set<string>()
  for (const declaration of declarations) {
    if (!declaration) continue
    for (const [id, choice] of Object.entries(declaration)) {
      if (choice?.enabled === false) off.add(id)
      else off.delete(id)
    }
  }
  return off
}

/**
 * The refusal for a project that names a policy which is not installed.
 *
 * 🔴 **Refused, never ignored, and the direction is the whole point.** A folder that asks for a
 * guard and does not get one must not look like a folder that asked for nothing: silently dropping
 * the line means the product reports the strictest reading of the file while running the loosest.
 * So every tool call in that folder is refused until the id is installed or the line is removed —
 * fail-closed, in the same direction as `readsContent` and `safetyCritical`.
 *
 * ⚠️ The message names the id, the file, and both ways out, because a model told merely "denied"
 * will spend turns trying to get a permission widened that has nothing to do with it.
 */
export function missingPolicyRefusal(missing: readonly string[], file: string, installed: readonly string[]) {
  const names = missing.map((id) => `\`${id}\``).join(", ")
  return (
    `Refused before running: this folder's \`${file.replaceAll("\\", "/")}\` asks for the pre-action ` +
    `${missing.length === 1 ? "policy" : "policies"} ${names}, and ${missing.length === 1 ? "it is" : "they are"} ` +
    `not installed in this NovaClaw. A requested guard that is missing is not the same as no guard, so ` +
    `every tool call in this folder is refused rather than run unpoliced — retrying, or calling a ` +
    `different tool, will be refused the same way. ` +
    `Installed policies right now: ${installed.length === 0 ? "(none)" : installed.map((id) => `\`${id}\``).join(", ")}. ` +
    `The user can fix this by installing the missing ${missing.length === 1 ? "policy" : "policies"} or by ` +
    `removing the entry from the \`policies\` section of that file; say so in your reply and stop retrying.`
  )
}

/**
 * The refusal for a project that names a policy the USER has switched off in Settings.
 *
 * 🔴 **Spelled differently from {@link missingPolicyRefusal} because the fix is different, and that
 * is the whole reason it is its own function.** "This NovaClaw has never heard of that policy" and
 * "it is installed and you turned it off" send a reader in opposite directions — one goes looking
 * for something to install, the other flips a switch they already own. One message covering both
 * would send half its readers the wrong way, which is the mistake `settings.project.invalid` records
 * for its own two reasons.
 *
 * ⚠️ The DIRECTION is the same as the missing case, and it has to be: a folder that asked for a
 * guard and did not get one is refused rather than run unpoliced. Turning a policy off is allowed —
 * it is the operator's own instance — but it cannot silently downgrade a folder that declared it.
 */
export function disabledPolicyRefusal(disabled: readonly string[], file: string) {
  const names = disabled.map((id) => `\`${id}\``).join(", ")
  const one = disabled.length === 1
  return (
    `Refused before running: this folder's \`${file.replaceAll("\\", "/")}\` asks for the pre-action ` +
    `${one ? "policy" : "policies"} ${names}, which ${one ? "is" : "are"} installed in this NovaClaw but ` +
    `switched OFF in Settings. A requested guard that has been turned off is not the same as no guard, so ` +
    `every tool call in this folder is refused rather than run unpoliced — retrying, or calling a different ` +
    `tool, will be refused the same way. Only the person at this computer can resolve it, in Settings → ` +
    `Policies (switch ${one ? "it" : "them"} back on) or by removing the entry from the \`policies\` section ` +
    `of that file. You cannot fix this from inside the session: say so in your reply and stop retrying.`
  )
}
