export * as PermissionV2 from "./permission"

import path from "path"
import { makeLocationNode } from "./effect/app-node"
import { Global } from "./global"
import { Context, Deferred, Effect as EffectRuntime, FiberSet, Layer, Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import {
  ASK_BEFORE_CHANGES_RULES,
  attendedRoot,
  autoResolvedMode,
  chainAutoGrant,
  EFFECTIVE_CONFIG_DEFAULTS,
  MODE_RULES,
  resolveSessionConfig,
  rootAttendance,
  unattendedStanceRules,
  type PermissionMode,
} from "./session/config-resolve"
import { PermissionSaved } from "./permission/saved"

/** Where an Analyze-mode session may still write its report: the app's own temp dir, which the agent
 *  baseline already whitelists for external read/write. Slashed to match `LocationMutation.resolve`. */
const REPORT_RESOURCE = path.join(Global.Path.tmp, "*").replaceAll("\\", "/")

export { Effect, Rule, Ruleset } from "@novaclaw/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
  /** Canonical identities of the files the user attached, resolved once for this provider turn. */
  attachmentPaths: Schema.Array(Schema.String).pipe(Schema.optional),
  /**
   * What this mutation is about to touch, as {permission resource, canonical path} PAIRS.
   *
   * ⚠️ Pairs, not two parallel arrays. The upstream PR carried `targetPaths` alongside `resources`
   * and recovered the resource by index — but `apply-patch.ts` builds the two with SEPARATE `new
   * Set()` dedupes over DIFFERENT key spaces (`resource` is Location-relative for internal paths and
   * canonical for external ones, `location-mutation.ts:52`), so the arrays can differ in length and
   * the indices silently diverge. `resources[-1]` is `undefined` in JavaScript rather than an error,
   * so the protection would then vanish without a sound — a safety check that fails OPEN. A pair
   * cannot be misaligned.
   */
  targets: Schema.Array(Schema.Struct({ resource: Schema.String, canonical: Schema.String })).pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionV2.RejectedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

/**
 * Why a denial happened, when the plain rule list would mislead the model. `unattended-confined`
 * = the unattended confinement stance refused an out-of-folder create/modify
 * (`config-resolve.ts` → `UNATTENDED_CONFINED_RULES`); the generic wording tells the model to "ask
 * the user to adjust permissions", which is exactly the advice that hangs an unattended run.
 *
 * ⚠️ `chain-unreadable` is the SAME refusal for a DIFFERENT reason, and it exists because ruling 2
 * forbids describing a fault falsely in either direction. The stance also engages when the chain
 * root could not be established at all (`RootType` = `"unknown"` — a dangling `parent_id`, or a
 * cyclic tree): refusing is right, but telling the model "this is an
 * UNATTENDED session" would be a claim about something we just failed to read, and it points the
 * user at the wrong thing. Same third-reason shape `HostExec.denyMessage` carries for the
 * hostility tri-state. This literal set is core-internal — `DeniedError` here is
 * `PermissionV2.DeniedError`, distinct from `@novaclaw/schema`'s `PermissionDeniedError`, and
 * neither the reason nor this class is projected into the HttpApi contract, so adding a member
 * drifts no generated artifact (checked 2026-07-28).
 *
 * ── the SECOND pair (the B4c follow-up), and why it is a pair for the same reason ───────────────
 * `unattended-unanswerable` / `unanswerable-chain-unreadable` are the two attributions of the OTHER
 * unanswerable ask: not "you reached outside your folder" but "nobody ruled on this action at all,
 * so the verdict is `ask`, and there is no operator to answer it". The first three cover a
 * CLASSIFIED boundary; these two cover the fall-through. They are separate literals rather than a
 * reuse of the first pair because the first pair's wording prescribes *"do the work inside this
 * session's folder instead"* — true advice for an out-of-folder write, and a false description of
 * the fault for a `webfetch` or an MCP call that has no path at all.
 */
export const DenialReason = Schema.Literals([
  "unattended-confined",
  "attachment-protected",
  "chain-unreadable",
  "unattended-unanswerable",
  "unanswerable-chain-unreadable",
])
export type DenialReason = typeof DenialReason.Type

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionV2.DeniedError", {
  rules: Permission.Ruleset,
  reason: DenialReason.pipe(Schema.optional),
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError

/**
 * 1J: lower a permission failure into a model-legible message (denial as observation, never a
 * halt). Tools' blanket `mapError` absorbers call this FIRST, so a denial keeps its identity —
 * including the user's optional reject feedback — instead of collapsing into "Unable to <x>".
 */
export function denialMessage(error: unknown): string | undefined {
  if (error instanceof DeniedError) {
    const denied = error.rules.filter((rule) => rule.effect === "deny")
    const rules = denied.length ? denied : error.rules
    const actions = [...new Set(rules.map((rule) => rule.action))].join(", ") || "unknown"
    const resources = [...new Set(rules.map((rule) => rule.resource))].join(", ") || "unknown"
    // Deny-fast: an unattended run must never be told to "ask the user" — nobody is there, and a
    // model that waits or retries burns the whole run. Name the boundary and the way forward.
    if (error.reason === "unattended-confined")
      return (
        `Permission denied: this is an UNATTENDED session, confined to its own working folder. ` +
        `Creating or modifying anything outside that folder is refused outright (action '${actions}') — ` +
        `no user is present to approve an exception, so waiting or retrying will change nothing. ` +
        `Do the work inside this session's folder instead: relative paths resolve there, and you may create ` +
        `whatever files and subfolders you need. If something outside is genuinely required, finish what you ` +
        `can and name the blocked path in your result.`
      )
    // The same refusal, honestly attributed. The model is told what actually broke (the session
    // records) instead of being told something about itself that we could not check, and it is
    // given the same way forward — because the way forward is identical and a denial that only
    // says "no" is the hang this whole arm exists to avoid.
    if (error.reason === "chain-unreadable")
      return (
        `Permission denied: this session's parent chain could not be read, so there is no way to tell whether ` +
        `anyone is present to approve an exception (action '${actions}'). An attendance question this instance ` +
        `cannot answer is not a licence to act outside the working folder, so the request is refused rather ` +
        `than granted on a guess — what is broken is the session records, not your request, and no user reply ` +
        `can unblock it. Do the work inside this session's folder instead: relative paths resolve there, and ` +
        `you may create whatever files and subfolders you need. If something outside is genuinely required, ` +
        `finish what you can and name the blocked path in your result.`
      )
    // Same deny-fast reasoning, different boundary: the file is one the USER attached, and this is
    // an unattended run, so there is nobody to grant the exception. Name the file, and name the way
    // forward — writing the result somewhere else is almost always what was wanted anyway.
    if (error.reason === "attachment-protected")
      return (
        `Permission denied: '${resources}' was ATTACHED to this conversation by the user, so it is one of ` +
        `their own source files rather than working material. This is an UNATTENDED session, so no one is ` +
        `present to approve modifying it and waiting or retrying will change nothing. Write your output to a ` +
        `NEW file instead and name the attached file in your result if it genuinely needs to change.`
      )
    // The B4c follow-up. Nobody RULED on this action, so the evaluator's honest verdict is `ask` —
    // and in an unattended chain an ask has no answerer, which makes it a hang rather than a gate.
    // The refusal has to be ACTIONABLE, not merely legible: name the action, say the waiting is
    // pointless, and say what a human would have to do IN ADVANCE for the next run to have it.
    if (error.reason === "unattended-unanswerable")
      return (
        `Permission denied: action '${actions}' on '${resources}' needs a human's approval and no standing ` +
        `rule grants it, but this is an UNATTENDED session — no operator is present to answer a consent ` +
        `prompt. A prompt here would stall the whole run instead of gating it, so the request is refused ` +
        `immediately. Waiting, retrying, or trying to get the permission widened mid-run will change nothing. ` +
        `Continue with the tools you ARE allowed to use and finish what you can. Making '${actions}' available ` +
        `to unattended runs takes a grant made in advance — approved once with "always" in an attended chat, ` +
        `or allowed for this agent in the instance permission settings — so if the task genuinely cannot ` +
        `finish without it, name '${actions}' in your result and stop trying it.`
      )
    // The same refusal, honestly attributed — ruling 2 in both directions. We did not establish that
    // this run is unattended; we failed to read the chain that would have told us. Saying "this is an
    // UNATTENDED session" here would be a claim about something we never checked, and it would point
    // the operator at the schedule instead of at the broken session records.
    if (error.reason === "unanswerable-chain-unreadable")
      return (
        `Permission denied: action '${actions}' on '${resources}' needs a human's approval and no standing ` +
        `rule grants it, and this session's parent chain could not be read — so there is no way to tell ` +
        `whether anyone is present to answer a consent prompt. An attendance question this instance cannot ` +
        `answer is not a licence to ` +
        `act, and a prompt nobody may be there to answer would stall the run rather than gate it, so the ` +
        `request is refused rather than granted on a guess. What is broken is the session records, not your ` +
        `request, and no user reply can unblock it. Continue with the tools you ARE allowed to use and ` +
        `finish what you can; if the task genuinely cannot finish without '${actions}', name it in your ` +
        `result and stop trying it.`
      )
    return `Permission denied by policy: action '${actions}' on '${resources}' is not allowed in this mode. Do not retry the same call — work within permitted paths and actions, or ask the user to adjust permissions.`
  }
  if (error instanceof CorrectedError)
    return `The user declined this action and said: "${error.feedback}". Follow the user's direction instead of retrying the same call.`
  if (error instanceof RejectedError)
    return `The user declined permission for this action. Do not retry the identical call. If the task can proceed another way (a different tool, a permitted path, or answering from what you already know), CONTINUE with that approach now; only stop to ask the user when no alternative exists.`
  return undefined
}

/** The actions that can destroy an attached file. `create` is absent on purpose — a create whose
 *  path already resolves to an attachment arrives here as `edit`/`write` (see `write.ts`), and
 *  denying genuine creates would refuse the very "write your output elsewhere" the denial advises. */
const MUTATING_ACTIONS = new Set(["edit", "write", "trash"])

export type MutationTarget = { readonly resource: string; readonly canonical: string }

/**
 * The attachment this mutation is about to overwrite, if any.
 *
 * Comparison is by canonical path on both sides — `LocationMutation` realpaths the target
 * (`location-mutation.ts:100-107`) and `AttachmentPaths` realpaths the attachment — so symlink
 * aliases, `..` segments, URI escaping and duplicate basenames in different directories all resolve
 * correctly, and none of them can be used to slip past the check.
 *
 * ⚠️ Case: comparison is exact, which is right on Linux and relies on both sides having been
 * realpath'd on Windows (Node returns the on-disk casing there, so they agree). A path that never
 * existed cannot be an attachment, so the one branch of `LocationMutation` that does not realpath —
 * a not-yet-created file — is unreachable here.
 */
export function protectedAttachment(
  action: string,
  targets: readonly MutationTarget[],
  attachmentPaths: readonly string[],
): MutationTarget | undefined {
  if (!MUTATING_ACTIONS.has(action)) return undefined
  const attachments = new Set(attachmentPaths)
  return targets.find((target) => attachments.has(target.canonical))
}

export type ReplyVerdict = "allow" | "deny"
export type ReplyScope = "once" | "file" | "always"

/** 1K: normalize the six verdict-scope replies (+ the legacy trio) into {verdict, scope}. */
export function normalizeReply(reply: Reply): { verdict: ReplyVerdict; scope: ReplyScope } {
  switch (reply) {
    case "once":
    case "allow-once":
      return { verdict: "allow", scope: "once" }
    case "always":
    case "allow-always":
      return { verdict: "allow", scope: "always" }
    case "reject":
    case "deny-once":
      return { verdict: "deny", scope: "once" }
    case "allow-file":
      return { verdict: "allow", scope: "file" }
    case "deny-file":
      return { verdict: "deny", scope: "file" }
    case "deny-always":
      return { verdict: "deny", scope: "always" }
  }
}

/**
 * 1K: the resources a reply persists. `file` scope saves the request's CONCRETE resources (this
 * file only); `always` saves the request's broad `save` patterns; `once` persists nothing.
 */
export function savedResources(
  request: { readonly resources: readonly string[]; readonly save?: readonly string[] },
  scope: ReplyScope,
): readonly string[] {
  if (scope === "once") return []
  if (scope === "file") return request.resources
  return request.save ?? []
}

// ─────────────────────────────────────────────────────────────────────────────
// THE AMBIENT-SAFE BASELINE (v0.2.0 B4c).
//
// The compiled floor every built-in agent's ruleset opens with (`plugin/agent.ts`). It REPLACES
// the catch-all `{ action: "*", resource: "*", effect: "allow" }` that used to sit on that first
// line, and the inversion is the entire point: an action nobody listed here falls through to
// `evaluate`'s `ask` default instead of being granted by a rule written before the action existed.
//
// ⚠️ WHY THE CATCH-ALL HAD TO GO. It did not merely widen a default — it silently DEFEATED every
// per-action gate that had no later rule of its own, so each gate read as protection while granting
// itself. Measured on the tree the day this landed, that covered `js`, `spawn`, `kb`, `skill`,
// `webfetch`, `revert`, `provision`, `define_tool`, `register-app`, the three `messenger.*` actions,
// every MCP tool (whose own gate comment claimed first-call-asks parity) and every ad-hoc tool a
// model invents at runtime — a name no overlay written ahead of time can possibly mention, which is
// why growing `MODE_RULES` could never close it (see `session/config-resolve.ts`).
//
// ── MEMBERSHIP: the three tests an action must pass ──────────────────────────────────────────
// An action belongs here only if it (1) cannot mutate the host, (2) cannot egress, and (3) cannot
// change what a LATER turn or a later session runs. Ruling 4's *unclassified ⇒ privileged* is the
// tie-break, and it points one way: an action wrongly LEFT OUT costs one consent card that the user
// can answer "always"; an action wrongly PUT IN is a gate that grants itself, which is the fault
// this baseline exists to end (ruling 2 — *a fault is never described falsely*).
//
//  · `read`      — file reads (`tool/read.ts`, `tool/read-hex.ts`). Cannot mutate, cannot egress.
//                  Two things still narrow it and neither is weakened by living here: a target
//                  outside the Location passes a SEPARATE `external_directory_read` assert first
//                  (`location-mutation.ts`), and `plugin/agent.ts`'s `.env` refinements sit AFTER
//                  this rule in the same ruleset, so findLast keeps them winning.
//  · `explore`   — the glob + grep grant; listing and searching are ONE class (`tool/glob.ts`,
//                  `tool/grep.ts`, which assert exactly this action). Same shape as `read` and
//                  gated the same way outside the Location. No compiled rule ever named it, so it
//                  reached the catch-all: leaving it out would make every grep a consent card.
//  · `todowrite` — the session's own task list (`SessionTodo.update`, keyed by sessionID). It is a
//                  write, but only to the session's own scratch state: no filesystem, no network,
//                  no config, and nothing that outlives the session it belongs to. That last clause
//                  is ruling 4's fourth test — *no text that reaches a FUTURE session's prompt* —
//                  and it is precisely what keeps `define_tool` (whose manual IS saved for later
//                  turns to read) on the other side of the line.
//  · `resource_status` — reads the instance's existing Storage pressure probe. No mutation, egress or
//                  durable effect; it is the on-demand replacement for spending healthy RAM/disk lines
//                  in every turn's system context, so asking permission to verify recovery would defeat it.
//  · `webfetch`  — deliberate product default (owner, 2026-08-04): models may read public URLs without
//                  stopping for a consent card. OFF-C/airgap policy, SSRF checks, response limits and the
//                  traffic governor remain independent hard boundaries around the request.
//  · `js`        — deliberate product default (owner, 2026-08-04): inline computation is part of the
//                  normal reasoning surface. Analyze mode still hard-denies execution, while Build and
//                  more permissive modes can compute without prompting on every fresh install.
//
// ⚠️ WHAT IS DELIBERATELY ABSENT, so the shortness is not read as an oversight. The mutation/exec
// cluster (`edit`/`write`/`create`/`trash`/`bash`) is NOT here and does not need to be: the default
// permission mode is `bypass`, whose overlay allows all five on `*` (`MODE_RULES`), so a default
// install behaves as it did. What changed is that those five are now granted by THE POSTURE THE
// USER PICKED rather than by a catch-all — which is what finally makes picking `ask` or `plan` mean
// something for everything else too. `spawn`, `kb`, `skill`, `revert`,
// `provision`, `define_tool`, `register-app`, `messenger.*`, MCP tools and ad-hoc tools each fail at
// least one of the three tests above and now ASK on first use; the answer is saveable
// (allow-always), so the cost is one card per capability per install, not one per call.
//
// ⚠️ AND THIS IS A FLOOR, NOT A CEILING. User config, agent config and saved answers are all
// appended AFTER it (`evaluateInput` below), so a repairing agent or a user can still widen it — the
// self-healing law is untouched. Narrowing it is what needs a deliberate edit here.
//
// ✅ THE CONSEQUENCE THIS INVERSION OPENED IS NOW CLOSED, in `evaluateInput`'s last arm. The gap,
// recorded here while it was open: an UNATTENDED chain has nobody to answer a card, and the deny-fast
// stance (`config-resolve.ts` §UNATTENDED CONFINEMENT) converts external-directory WRITES into an
// immediate refusal, so everything else PARKED. Before B4c the catch-all hid that for the newly-gated
// actions; after it, an unattended
// root whose model called `webfetch`, `spawn`, `skill`, `kb`, `js` or an MCP tool sat on a pending ask
// — the measured pathology AGENTS.md records ("the run looking alive and doing nothing"). The fix is
// the one the stance's own doctrine dictates (*an ask nobody is present to answer is a HANG, not a
// gate*): an `ask` verdict under a non-attended root is now refused IMMEDIATELY, with its own
// `DenialReason` (`unattended-unanswerable`, or `unanswerable-chain-unreadable` when the chain is what
// we failed to read) and wording that names the grant-in-advance path out. This list was NOT widened
// to do it, which is the part that matters here: an egress or execution action does not become
// ambient-safe because a scheduled run wanted it.
// ─────────────────────────────────────────────────────────────────────────────
export const AMBIENT_SAFE_BASELINE: Permission.Ruleset = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "explore", resource: "*", effect: "allow" },
  { action: "todowrite", resource: "*", effect: "allow" },
  { action: "resource_status", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "js", resource: "*", effect: "allow" },
]

/**
 * The rules in a ruleset that grant EVERYTHING — the exact shape B4c removed from the compiled
 * baseline (`{ action: "*", resource: "*", effect: "allow" }`).
 *
 * A function rather than a note in a comment, because "no ruleset we compile opens with a catch-all
 * allow again" is an invariant a re-added line would satisfy silently and green — the defect class
 * ruling 1 names. A USER may still write such a rule; that is their instance and their call. This
 * pins only what WE ship, and `test/permission-baseline.test.ts` runs it over every built-in agent
 * the agent plugin actually builds rather than over a hand-copied fixture.
 */
export const catchAllAllowRules = (ruleset: Permission.Ruleset): Permission.Ruleset =>
  ruleset.filter((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")

// ─────────────────────────────────────────────────────────────────────────────
// AUTO MODE — where a session's SELF-GRANT lives (todo/permissions.md; the algebra and the whole
// safety argument are in `session/config-resolve.ts` §AUTO MODE).
//
// ── WHY THIS IS A PROCESS-LOCAL MAP AND NOT A COLUMN, stated rather than discovered later ──────
//
//  1. **It is run-scoped by design, and that is the honest scope for it.** A self-grant answers
//     *"what level is this session operating at RIGHT NOW, and on whose written say-so"*. A turn
//     runs inside a live instance; if the instance goes away, so does the run. Resetting to the
//     mode the USER picked is the fail-closed direction for the half that matters (a raise), and it
//     never exceeds what the user granted in either direction.
//  2. **A grant must never be mistaken for the user's own pick.** `session.permission_mode` is the
//     ceiling precisely because only the user's surfaces write it. Storing the grant in the same
//     column would let the agent ratchet its own ceiling upward — *an agent that can raise its own
//     ceiling has no ceiling* — and storing it in a NEW column would put a second per-session mode
//     fact on the wire, which is the fork the mode picker already suffered once.
//  3. **Keying by sessionID alone is correct, not a shortcut.** Session ids are globally unique and
//     `SessionStore` is itself a GLOBAL node, so two Locations can never collide here.
//
// ⚠️ **What this costs, named because ruling 2 forbids overclaiming:** a *lowering* does not
// survive an instance restart. `tool/permission.ts` says so in the text it returns, so a model
// never reports a durable revocation it did not make. The durable half needs a `SessionConfig`
// field + a column + a migration; it is filed, not silently assumed.
//
// ⚠️ **Growth:** one small entry per session that has actually called the `permission` tool, for
// the life of the process — the same shape and a strictly smaller footprint than `pending` below.
// ─────────────────────────────────────────────────────────────────────────────

/** A session's self-granted permission level, and the written justification that bought it. */
export interface AutoGrant {
  readonly mode: PermissionMode
  /** The model's own words. Never empty — `tool/permission.ts` refuses a blank one. */
  readonly justification: string
  /** Epoch millis, so the tool can report *when* the session took this level. */
  readonly at: number
}

const autoGrants = new Map<string, AutoGrant>()

/** The self-grant a session currently holds, or `undefined`. */
export const autoGrant = (sessionID: string): AutoGrant | undefined => autoGrants.get(sessionID)

/** The self-granted MODE only — the shape `chainAutoGrant`'s `grantOf` lookup wants. */
export const autoGrantMode = (sessionID: string): PermissionMode | undefined => autoGrants.get(sessionID)?.mode

/**
 * Record a session's self-grant. The ONLY writer is `tool/permission.ts`, which is also the only
 * place that checks the ceiling and spends the permission action — but the guarantee does not rest
 * on that, because `autoResolvedMode` folds whatever lands here with `moreRestrictive` and so
 * cannot widen anything (see `config-resolve.ts` §AUTO MODE).
 */
export const setAutoGrant = (sessionID: string, grant: AutoGrant): void => {
  autoGrants.set(sessionID, grant)
}

/** Whether ANY session in this process holds a self-grant — the evaluator's cheap skip. */
export const anyAutoGrant = (): boolean => autoGrants.size > 0

/** Test-only reset. Production never clears the map; a session's level is its own until it moves. */
export const clearAutoGrants = (): void => {
  autoGrants.clear()
}

// ⚠️ The `resource` match is only as strong as what `resource` MEANS for that action. For path-shaped
// actions (read/write/external_directory_*) it is a resolved, canonicalized path — a real semantic
// gate. For `bash` the resource is the raw COMMAND STRING, and matching it is a prompt-reduction
// convenience, NOT containment: see the boundary note in `util/wildcard.ts`. Do not add deny-rules
// here expecting them to stop a prompt-injected command; that is the AgentJail program's job.
export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

export const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const pending = new Map<ID, Pending>()

    // Asked/Replied must carry this service's location EXPLICITLY: publishes can run on fibers
    // without Location.Service in context (tool settlement, the session-deleted sweep), and the
    // per-instance /event stream drops location-less events — the CLI deny path hung on exactly
    // that (a runner-origin ask never reached the subscriber).
    const eventLocation: Location.Ref = {
      directory: location.directory,
      ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
    }

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    // Reject every pending ask belonging to a session, publishing Replied so clients clear
    // their stores. Used by the deny-cascade below and by the session-deleted sweep: once the
    // session row is gone the V2 session-scoped reply route can never settle these (it 404s on
    // the missing session), so an orphaned ask would pollute pending lists and attention badges
    // forever with no way to dismiss it.
    const rejectSessionPending = (sessionID: string) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          for (const [id, item] of pending) {
            if (String(item.request.sessionID) !== sessionID) continue
            yield* events.publish(
              Event.Replied,
              {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              },
              { location: eventLocation },
            )
            yield* Deferred.fail(item.deferred, new RejectedError())
            pending.delete(id)
          }
        }),
      )

    // A deleted session takes its pending asks with it. `session.deleted` is the session-level
    // V1 event the engine still emits for every delete (kept through F1g), so this covers both
    // engines with one subscription. A SETTLED DRAIN does too (owner-hit 2026-07-22): the only
    // thing that can consume an answer is the tool awaiting it inside the drain, so once the
    // drain publishes idle/exited (Stop, exit, error — the fiber is gone) every still-pending
    // ask is an orphan. Left alone it wedged the chat permanently: the ask dock replaces the
    // composer while asks are pending, so after an interrupt the user faced stale Allow/Deny
    // buttons with no composer, no Stop, and no way to re-prompt.
    // ⚠️ The sweep must run DETACHED from the publishing fiber: the idle status is published
    // from the interrupted drain's finalizer under `Effect.ignore`, and a listener effect run
    // inline there dies with the fiber and is swallowed (measured live 2026-07-22 — idle on the
    // wire, no Replied). The service-scoped FiberSet runs it on a healthy fiber instead.
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const settledOrphans = (event: { type: string; data: unknown }) => {
      if (event.type === "session.deleted")
        return rejectSessionPending(String((event.data as { sessionID?: string }).sessionID ?? ""))
      if (event.type === "session.status") {
        const data = event.data as { sessionID?: string; status?: { type?: string } }
        if (data.status?.type === "idle" || data.status?.type === "exited")
          return EffectRuntime.sync(() => fork(rejectSessionPending(String(data.sessionID ?? "")))).pipe(
            EffectRuntime.asVoid,
          )
      }
      return EffectRuntime.void
    }
    const unsubscribe = yield* events.listen(settledOrphans)
    yield* EffectRuntime.addFinalizer(() => unsubscribe)

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ origin: location.origin })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: item.effect ?? "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return agent?.permissions ?? missingAgentPermissions
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    // The whole resolved config, not just the mode: the evaluator also needs the surgical-edits switch.
    const sessionConfig = EffectRuntime.fnUntraced(function* (sessionID: SessionV2.ID) {
      return yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, (id) => sessions.get(id as SessionV2.ID))
    })

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      // 1K: the session's resolved permission MODE contributes a rule overlay. Appended after the
      // agent's configured rules (last-match-wins) so the user's explicit mode outranks agent
      // defaults. The early hard-deny check runs over the configured chain and the mode overlay
      // SEPARATELY: combined last-match would let a later non-deny mode rule (ask-mode's `ask`,
      // bypass's `allow`) shadow an explicit configured deny — a mode may convert silent allows
      // into consent or raise defaults, but never soften a deny; and a saved allow-always can
      // never override plan/surgical mode denies.
      // ⚠️ This catch is the same permissive shape the rootType one below used to have, and it is
      // deliberately LEFT for now rather than half-fixed: `EFFECTIVE_CONFIG_DEFAULTS.permissionMode`
      // is `bypass`, so a failed config walk would fall back to the most capable practical mode.
      // It is unreachable for the same measured reason (`SessionStore.get` orDies, so `E` is
      // `never`), and unlike the attendance question there is no honest safe answer available here
      // — every `PermissionMode` is a positive claim about what the user chose, and picking `plan`
      // on a fault would refuse an ordinary interactive turn's edits. The right cure is a
      // tri-state on the mode, which is a wider change than this unit owns; filed in the report.
      const resolved = yield* sessionConfig(input.sessionID).pipe(
        EffectRuntime.catch(() => EffectRuntime.succeed(EFFECTIVE_CONFIG_DEFAULTS)),
      )
      // ⚠️ `mode` is NOT read off `resolved` here any more — it is computed below, AFTER `rootType`,
      // because Auto mode's cap is keyed on attendance. Moving the line is the whole ordering
      // change; every consumer of `mode` already sat below the attendance walk.
      // Deny-fast — the unattended confinement stance (config-resolve.ts §UNATTENDED CONFINEMENT).
      // Under an UNATTENDED chain ROOT, an out-of-folder create/modify is
      // refused OUTRIGHT instead of being parked as an ask nobody can answer. Its own HARD arm,
      // checked FIRST, so neither a later mode rule, an agent-level allow-all, nor a saved
      // allow-always can soften it; and TAGGED, so the model gets the unattended wording instead
      // of "ask the user to adjust permissions". Attendance is the ROOT's property (a child cannot
      // declare itself attended out of it) and `yolo` — unreachable for a narrowed child — is the
      // one deliberate way out.
      // ⚠️ `rootAttendance`, not `rootSessionType`: this seam can NAME an unreadable chain, so it
      // takes the tri-state undiluted rather than the adapter's collapsed `SessionType`.
      // ⚠️ And the catch answers `"unknown"`, not the attended default it used to. Two things
      // measured 2026-07-28 about that catch: (1) it is UNREACHABLE in production — `sessions.get`
      // is `SessionStore.get`, whose DB failure is `orDie` (store.ts:36), so `E` is `never` here
      // and a real store fault takes the whole turn down as a defect rather than landing on a
      // permissive default (the filing that opened this item assumed the opposite); (2) it is kept
      // anyway, because `rootAttendance` is generic in `E` and the day a caller hands in a store
      // that fails TYPED, "we could not read the chain" is the honest answer and the safe one.
      const rootType = yield* rootAttendance(input.sessionID, (id) => sessions.get(id as SessionV2.ID)).pipe(
        EffectRuntime.catch(() => EffectRuntime.succeed("unknown" as const)),
      )
      // ── AUTO MODE: the session's own self-grant, folded down the chain ────────────────────────
      // `autoResolvedMode` folds with `moreRestrictive`, so this line is structurally incapable of
      // granting anything the user did not — it can only narrow (config-resolve.ts §AUTO MODE). The
      // walk is SKIPPED entirely while nothing in this process holds a grant, so a default install
      // pays neither a query nor an allocation for the feature.
      // ⚠️ It folds the whole CHAIN, not just this session, which is what makes a parent's
      // self-revocation reach the children it spawns afterwards (todo.md → Vision → *Privilege
      // self-revocation*: "drops capabilities from itself AND ITS CHILDREN"). A child resolves its
      // mode from the parent's stored ROW, and a self-grant deliberately never touches that row, so
      // without this fold the revocation would be escapable by spawning.
      const chainGrant = anyAutoGrant()
        ? yield* chainAutoGrant(input.sessionID, (id) => sessions.get(id as SessionV2.ID), autoGrantMode)
        : undefined
      const mode: PermissionMode = autoResolvedMode({
        resolvedMode: resolved.permissionMode,
        rootType,
        grant: chainGrant,
      })
      // ⚠️ WHAT THIS STANCE DOES **NOT** COVER, and why it matters more since 2026-07-30. The rules
      // it contributes are the `external_directory_write` class — the seam every mutating tool whose
      // resource is a PATH passes through. `bash` is not one of those: its resource is the command
      // STRING, and matching a command string is prompt-reduction, never containment (the boundary
      // note above `evaluate`). Until today that gap was closed for unattended chains one layer
      // down, by the JAIL: `AgentJail.decideBash` refused raw shell outright on a host with no
      // sandbox backend. The owner has reversed that default (see `agent-jail.ts`'s header — the
      // per-session `safeMode` switch restores it), so an unattended command can now run raw on a
      // Windows host and write wherever the user can.
      //
      // Nothing here changes as a result, and that is deliberate rather than an omission: adding a
      // `bash` deny row would refuse the capability the directive exists to grant, and adding any
      // command-string rule would restore exactly the false promise `MODE_RULES.plan`'s comment
      // rejects. What covers the gap meanwhile is stated where it is enforced — the project-scope
      // system-prompt section (`session/runner/system-compose.ts`, an INFORMATIONAL lever, named as
      // one) plus every path-gated tool below — and what closes it is a real Windows/macOS backend,
      // deferred to v0.3.0 with Auth. If you are here because you want a mechanical bound on
      // out-of-folder shell writes: it belongs in `agent-jail.ts`, not in this ruleset.
      const stance = unattendedStanceRules(rootType, mode)
      const configuredRules = yield* configured(input.sessionID, input.agent)
      // The mode overlay, plus Analyze's one carve-out. "Analyze" (mode `plan`) is read-only EXCEPT that it
      // may still write its findings somewhere — a review that cannot save its own report is not much use.
      // The allows land AFTER the mode denies (findLast) so they apply to the temp dir and nowhere else, and
      // they are folded into the same array the early deny-fast arm checks, or that arm would refuse the
      // write before ever seeing the exception.
      const modeRules =
        mode === "plan"
          ? [
              ...MODE_RULES[mode],
              { action: "create", resource: REPORT_RESOURCE, effect: "allow" as const },
              { action: "write", resource: REPORT_RESOURCE, effect: "allow" as const },
              { action: "edit", resource: REPORT_RESOURCE, effect: "allow" as const },
              { action: "external_directory_write", resource: REPORT_RESOURCE, effect: "allow" as const },
            ]
          : MODE_RULES[mode]
      // The two Tuning switches that were once modes. Both NARROW whatever mode is active and never widen
      // it, so they sit after the mode overlay and are included in the deny-fast arm below. Both default
      // OFF (no global `{ enabled }` block to inherit from), which is why absent means "do not apply".
      const featureRules: Permission.Ruleset = [
        // "Edits instead of overwriting": a full-file `write` is refused; `edit`/`create` still work.
        ...(resolved.surgicalEdits === true ? [{ action: "write", resource: "*", effect: "deny" as const }] : []),
        // "Ask before every change": the old `ask` mode's overlay, now composable with Analyze or Build.
        // Literally THE SAME list `MODE_RULES.ask` is (config-resolve.ts, ASK_BEFORE_CHANGES_RULES) —
        // it used to be a second copy of it, with nothing but a comment claiming they agreed.
        ...(resolved.askBeforeChanges === true ? ASK_BEFORE_CHANGES_RULES : []),
      ]
      // READ BASELINE. Reading outside the project folder is ordinary work — a toolchain, an SDK,
      // another checkout, or any other host-readable file. Every permission mode gets this same
      // capability; only WRITES distinguish `yolo` from the other modes. It sits at the lowest
      // precedence so an explicit user-authored permission rule can still narrow a particular path.
      const readBaseline: Permission.Ruleset = [{ action: "external_directory_read", resource: "*", effect: "allow" }]
      const rules = [...readBaseline, ...configuredRules, ...modeRules, ...featureRules, ...stance]
      if (denied(input, stance))
        return {
          effect: "deny" as const,
          rules,
          // The stance fired either because the root IS unattended or because we could not find
          // out. Same refusal, different fault — and ruling 2 says the model gets the true one.
          reason: (rootType === "unknown" ? "chain-unreadable" : "unattended-confined") as DenialReason | undefined,
        }
      if (denied(input, configuredRules) || denied(input, modeRules) || denied(input, featureRules))
        return { effect: "deny" as const, rules, reason: undefined as DenialReason | undefined }
      const saved = yield* savedRules()
      // ATTACHED-SOURCE PROTECTION. A file the user handed to the conversation is their own source of
      // truth, not the agent's working material, and nothing below this line would otherwise tell the
      // two apart. Ported from PR #9 by @DassaultFalconKing; the placement decisions are ours.
      //
      // ⚠️ It sits AFTER the mode overlay and after saved rules deliberately, and that is the whole
      // design. `EFFECTIVE_CONFIG_DEFAULTS.permissionMode` is **bypass**, whose overlay allows
      // edit/write/trash on `*`; `evaluate` resolves by findLast. Placed anywhere earlier this rule
      // would be shadowed on a DEFAULT install and the protection would not exist at all. The upstream
      // PR reached the same placement without saying so — recorded here so nobody "tidies" it.
      const attachment = protectedAttachment(input.action, input.targets ?? [], input.attachmentPaths ?? [])
      // A saved answer releases the protection only when it NAMES the file. Every one of these
      // asserts offers `save: ["*"]`, so honouring a wildcard saved rule would mean the first
      // ordinary "always allow edits" silently switched attachment protection off forever — the
      // protection would survive exactly until the most common reply. Answering "always" to THIS
      // file's own ask still ends it for that file, which is the user actually deciding. Mirrors
      // `governedSpecifically` above.
      const releasedByName =
        attachment !== undefined &&
        saved.some(
          (rule) =>
            rule.resource !== "*" &&
            Wildcard.match(input.action, rule.action) &&
            Wildcard.match(attachment.resource, rule.resource),
        )
      const protecting = attachment !== undefined && !releasedByName && mode !== "yolo"
      // Deny-fast rather than park, exactly as the unattended stance above does. An ask nobody can
      // answer is not protection — it is a hang, and pending asks are in-memory and location-scoped,
      // so it would not even survive the restart the maintenance plane is designed to cause. `yolo`
      // stays the one deliberate way out, matching `unattendedStanceRules`.
      if (protecting && !attendedRoot(rootType))
        return {
          effect: "deny" as const,
          rules: [...rules, ...saved],
          reason: "attachment-protected" as DenialReason | undefined,
          attachment,
        }
      const attachmentRules: Permission.Ruleset = protecting
        ? [{ action: input.action, resource: attachment.resource, effect: "ask" }]
        : []
      const all = [...rules, ...saved, ...attachmentRules]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      // ── AN ASK NOBODY CAN ANSWER IS A HANG, NOT A GATE — the B4c follow-up ────────────────────
      //
      // This is the LAST arm on purpose: everything that could legitimately answer for the action
      // has already spoken — the read baseline, the agent's configured rules, the mode
      // overlay, the Tuning switches, the stance, and saved answers. Only after
      // all of that resolves to `ask` do we know that NOBODY ruled on this action, which is exactly
      // the state B4c created by design: the compiled floor is an allowlist now
      // (`AMBIENT_SAFE_BASELINE`), so `js`, `spawn`, `skill`, `kb`, `webfetch`, `websearch`,
      // `revert`, `provision`, `define_tool`, `register-app`, `messenger.*`, every MCP tool and
      // every ad-hoc tool a model invents at runtime fall through to `evaluate`'s `ask` default.
      //
      // Under an UNATTENDED chain that ask parks on a consent card nobody will ever answer — and
      // `pending` above is an in-memory, location-scoped Map, so it does not even survive the
      // restart the maintenance plane is designed to cause. The measured pathology is "the run
      // looking alive and doing nothing". The stance's own doctrine already rules on it
      // (`config-resolve.ts` §UNATTENDED CONFINEMENT: *an ask nobody is present to answer is a
      // HANG, not a gate*), so the honest answer is an IMMEDIATE refusal the model can route
      // around, with its own reason so the wording can be actionable.
      //
      // ⚠️ WHY THERE IS NO `yolo` EXEMPTION HERE, unlike `unattendedStanceRules` and the attachment
      // arm above. Those two convert a GRANT into a refusal, so the mode that means "everything"
      // has to be the way out of them. This arm converts nothing: reaching it means the action was
      // never granted, in any mode — `MODE_RULES.yolo` names only the mutation cluster and the two
      // external classes, so an unattended `yolo` root calling `webfetch` was hanging too. A mode
      // is a statement about capability; attendance is a statement about who can answer, and `yolo`
      // cannot conjure an operator. Exempting it would preserve a hang in the name of a grant
      // nobody made.
      //
      // ⚠️ AND THIS IS NOT A NEW BOUNDARY — it converts a verdict, it never creates one. Anything
      // resolving to `allow` above is untouched (in-folder work, reads, `explore`, `todowrite`, the
      // whole mutation/exec cluster under the default `bypass`), and the way to give an unattended
      // run a gated capability is unchanged and stated in the denial text: grant it in ADVANCE —
      // one "always" answer in an attended chat, or an agent/instance permission rule. The
      // self-healing law is untouched: both of those are runtime-editable stores.
      //
      // The synthetic rules appended to `rules` ARE the verdict this arm reached, in the vocabulary
      // `denialMessage` reads — one per requested resource, because the call is refused for all of
      // them. `evaluate` already synthesises `{action, resource: "*", effect: "ask"}` when no rule
      // matches, so this is that rule with the verdict this arm gives it. Without them `relevant()`
      // would hand the error an EMPTY ruleset for a fall-through action (no compiled rule names it,
      // by definition) and the message would report the action AND the resource as "unknown" — ruling
      // 2 broken by the very text written to satisfy it. Per-resource rather than `*` so the model is
      // told WHICH url/command/path was refused, not just which verb.
      if (effect === "ask" && !attendedRoot(rootType))
        return {
          effect: "deny" as const,
          rules: [
            ...all,
            ...input.resources.map((resource) => ({ action: input.action, resource, effect: "deny" as const })),
          ],
          reason: (rootType === "unknown" ? "unanswerable-chain-unreadable" : "unattended-unanswerable") as
            | DenialReason
            | undefined,
        }
      return {
        effect,
        rules: all,
        reason: undefined as DenialReason | undefined,
        attachment: protecting ? attachment : undefined,
      }
    })

    function request(input: AssertInput, attachment?: MutationTarget): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        // The ask has to say WHY it is asking. Without this the user sees an ordinary edit prompt for
        // a file the rest of the session was allowed to touch freely, which reads as a glitch rather
        // than as the product noticing something — and a prompt whose reason is invisible is the
        // obscurantism the vision forbids. `metadata` is the existing channel; no new wire shape.
        metadata:
          attachment === undefined
            ? input.metadata
            : { ...input.metadata, attachmentProtection: true, attachmentPath: attachment.canonical },
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request, { location: eventLocation })
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input, result.attachment)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new DeniedError({
              rules: relevant(input, result.rules),
              ...(result.reason ? { reason: result.reason } : {}),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input, result.attachment), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                // The awaiting tool is going away — settled or INTERRUPTED (Stop). An entry
                // still pending here means nobody replied, so tell every client the ask is
                // dead (Replied/reject), or the ask dock wedges on a stale card with the
                // composer gone (owner-hit 2026-07-22). Detached via the service FiberSet:
                // this finalizer runs on the dying drain fiber, where an inline publish dies
                // with the fiber and is silently swallowed. (A settled reply deletes the
                // entry first, so this publishes nothing on the normal path.)
                if (pending.delete(item.request.id))
                  fork(
                    events
                      .publish(
                        Event.Replied,
                        {
                          sessionID: item.request.sessionID,
                          requestID: item.request.id,
                          reply: "reject",
                        },
                        { location: eventLocation },
                      )
                      .pipe(EffectRuntime.asVoid),
                  )
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(
            Event.Replied,
            {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              reply: input.reply,
            },
            { location: eventLocation },
          )

          const { verdict, scope } = normalizeReply(input.reply)
          const persisted = savedResources(existing.request, scope)

          if (verdict === "deny") {
            // 1K: a deny can persist (file/always scope) so the same ask never comes back.
            if (persisted.length)
              yield* saved.add({
                origin: location.origin,
                action: existing.request.action,
                resources: persisted,
                effect: "deny",
              })
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
            )
            pending.delete(input.requestID)
            // The deny cascades: the session's other queued asks reject too.
            yield* rejectSessionPending(String(existing.request.sessionID))
            return
          }

          if (persisted.length) {
            yield* saved.add({
              origin: location.origin,
              action: existing.request.action,
              resources: persisted,
              effect: "allow",
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (!persisted.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(
              Event.Replied,
              {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "always",
              },
              { location: eventLocation },
            )
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
