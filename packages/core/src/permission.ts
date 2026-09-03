export * as PermissionV2 from "./permission"

import path from "path"
import { makeLocationNode } from "./effect/app-node"
import { Global } from "./global"
import { Context, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { ProjectExclusion } from "./project-exclusion"
import { ProjectFileCache } from "./project-file-cache"
import { SessionEffectiveConfig } from "./session/effective-config"
import { Wildcard } from "./util/wildcard"
import {
  ASK_BEFORE_CHANGES_RULES,
  attendedRoot,
  autoResolvedMode,
  chainAutoGrant,
  EFFECTIVE_CONFIG_DEFAULTS,
  HOST_MUTATING_ACTIONS,
  MODE_RULES,
  rootAttendance,
  stanceOf,
  unattendedStanceRules,
  type PermissionMode,
  type RootType,
} from "./session/config-resolve"
import { ConfigPluginGlob } from "./config/plugin/glob"
import { FSUtil } from "./fs-util"
import { SessionAutoGrant } from "./session/auto-grant"
import { PermissionSaved } from "./permission/saved"
import { ShortChat } from "./session/runner/short-chat"

/** Where an Analyze-mode session may still write its report: the app's own temp dir, which the agent
 *  baseline already whitelists for external read/write. Slashed to match `LocationMutation.resolve`. */
const REPORT_RESOURCE = path.join(Global.Path.tmp, "*").replaceAll("\\", "/")

/**
 * The mode overlay, plus Analyze's one carve-out. "Analyze" (mode `plan`) is read-only EXCEPT that it
 * may still write its findings somewhere — a review that cannot save its own report is not much use.
 * The allows land AFTER the mode denies (findLast) so they apply to the temp dir and nowhere else, and
 * they are folded into the same array the early deny-fast arm checks, or that arm would refuse the
 * write before ever seeing the exception.
 */
export const modeRulesFor = (mode: PermissionMode): Permission.Ruleset =>
  mode === "plan"
    ? [
        ...MODE_RULES[mode],
        { action: "create", resource: REPORT_RESOURCE, effect: "allow" as const },
        { action: "write", resource: REPORT_RESOURCE, effect: "allow" as const },
        { action: "edit", resource: REPORT_RESOURCE, effect: "allow" as const },
        { action: "external_directory_write", resource: REPORT_RESOURCE, effect: "allow" as const },
      ]
    : MODE_RULES[mode]

/** The Tuning switches and the Chat stance as read by the evaluator and the horizon alike. */
export interface FeatureSwitches {
  readonly shortChat?: boolean | undefined
  readonly surgicalEdits?: boolean | undefined
  readonly askBeforeChanges?: boolean | undefined
}

/**
 * The two Tuning switches that were once modes, plus the Chat stance. All NARROW whatever mode is
 * active and never widen it, so they sit after the mode overlay and are included in the deny-fast
 * arm. Both switches default OFF (no global `{ enabled }` block to inherit from), which is why absent
 * means "do not apply".
 */
export const featureRulesFor = (resolved: FeatureSwitches): Permission.Ruleset => [
  ...ShortChat.permissionRules(resolved.shortChat),
  // "Edits instead of overwriting": a full-file `write` is refused; `edit`/`create` still work.
  ...(stanceOf("surgicalEdits", resolved.surgicalEdits)
    ? [{ action: "write", resource: "*", effect: "deny" as const }]
    : []),
  // "Ask before every change": the old `ask` mode's overlay, now composable with Analyze or Build.
  // Literally THE SAME list `MODE_RULES.ask` is (config-resolve.ts, ASK_BEFORE_CHANGES_RULES) —
  // it used to be a second copy of it, with nothing but a comment claiming they agreed.
  ...(stanceOf("askBeforeChanges", resolved.askBeforeChanges) ? ASK_BEFORE_CHANGES_RULES : []),
]

/**
 * The LAYERS the tool horizon is filtered against: what `evaluateInput` will refuse on every target,
 * so a tool the model could never use is not advertised and then refused (`registry.ts`'s
 * `whollyDisabled`). Until 2026-09-03 `materialize` was handed the agent's own ruleset alone, and an
 * Analyze session advertised eight tools it always refused.
 *
 * ⚠️ Layers, not one concatenated ruleset, because that is how the verdict reads them: the evaluator
 * refuses when the agent's rules OR the mode OR the switches OR the stance deny, each by its own
 * last match. Concatenated, a later layer's wildcard allow (Build allows `bash` on `*`) would mask
 * an earlier layer's wildcard deny (an agent floor that withdraws `bash`) and the horizon would
 * re-advertise a tool the verdict refuses — the fault this exists to remove, from the other side.
 *
 * Deliberately NOT the whole verdict:
 *  · project narrowing stays out — a project may not change the horizon, only the verdict;
 *  · saved answers and attachment protection stay out — they are per-target, never wildcard denies;
 *  · the auto-mode grant stays out — it can only make the mode MORE restrictive than `mode`
 *    (`autoResolvedMode` folds it under `autoCeiling`), so the horizon computed without it withdraws
 *    a subset of what the verdict refuses and never withholds a tool the verdict would allow.
 */
export const horizonLayers = (input: {
  readonly agent: Permission.Ruleset | undefined
  readonly mode: PermissionMode
  readonly resolved: FeatureSwitches
  readonly rootType: RootType
}): ReadonlyArray<Permission.Ruleset> => [
  input.agent ?? [],
  modeRulesFor(input.mode),
  featureRulesFor(input.resolved),
  unattendedStanceRules(input.rootType, input.mode),
]

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
  /** Require at least this verdict even when ordinary policy would be more permissive. */
  minimumEffect: Permission.Effect.pipe(Schema.optional),
  /** Additional resource identities that may deny this request but can never grant it. */
  denyAliases: Schema.Array(Schema.String).pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

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
 * `PermissionV2.DeniedError` — schema's `PermissionDeniedError` twin was deleted 2026-08-06 with the
 * V1 service that raised it, so this is now the only one — and
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
  /**
   * Asking was REMOVED as an outcome (owner, 2026-08-20: "Ask considered harmful").
   *
   * ⚠️ Distinct from the two above, and the distinction is ruling 2. Those say "we could not find
   * anyone to answer"; this says "we do not ask anyone". Attributing a policy decision to an
   * attendance check would send the operator to look at their schedule for something their settings
   * decided.
   */
  "ask-removed",
  /**
   * The target is inside the instance's EXTERNAL-PLUGIN directory — the one door in-process
   * third-party code comes through (`config/plugin/external.ts`).
   *
   * ⚠️ Its own literal for the same reason `project-denied` has one: the ADVICE is unlike every
   * other refusal here. The others describe a posture that can be widened — a setting, a rule, a
   * grant made in advance. This one cannot be widened by anybody, because the thing being protected
   * is not a file's contents but the fact that a file there RUNS, at this process's privilege,
   * before any NovaClaw API is consulted. Telling a model to "ask the operator to allow it" would
   * send it to negotiate for something no permission rule can give.
   */
  "plugin-door",
  /**
   * This folder's `novaclaw.json` refused it, and nothing else would have.
   *
   * ⚠️ Its own literal because the ADVICE differs from every other reason here: the others describe
   * the instance's own posture, which the person running NovaClaw chose. This one points at a FILE
   * IN THE FOLDER — possibly written by whoever the user cloned it from — and the action it
   * prescribes is "open Settings → Project and read `novaclaw.json`", not "change your settings".
   * A reader told only *denied* would go looking in the wrong place.
   */
  "project-denied",
  /** The nearest project file is present but cannot be enforced. These stay distinct because the
   * action is respectively fix, upgrade, or unlock; one generic denial would send two thirds of
   * users to the wrong remedy. */
  "project-file-invalid",
  "project-file-future-version",
  "project-file-unreadable",
])
export type DenialReason = typeof DenialReason.Type

const PROJECT_FILE_DENIAL_REASON: Record<ProjectFileCache.FaultKind, DenialReason> = {
  invalid: "project-file-invalid",
  "future-version": "project-file-future-version",
  unreadable: "project-file-unreadable",
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionV2.DeniedError", {
  rules: Permission.Ruleset,
  reason: DenialReason.pipe(Schema.optional),
}) {}

export type Error = DeniedError

/**
 * THE ONE REMEDY A DENIAL MAY PRESCRIBE, spelled once so the copy cannot outlive the code.
 *
 * 🔴 **Why this constant exists.** Two of the messages below used to end by telling the model that a
 * capability could be had by *"approving it once with 'always' in an attended chat"* — and that path
 * does not exist. `ask` was retired as an outcome (owner, 2026-08-20: *"Ask considered harmful"*), so
 * no consent card is ever shown and no reply is ever collected; `PermissionSaved.add`, the only
 * writer of the durable saved-grant table, has had **no production caller** since. The `permission`
 * table is read by `savedRules()` below and written by nothing an operator can reach from a chat.
 * So the copy prescribed a remedy the code had removed, and a model that followed it would spend its
 * result telling the user to answer a prompt they will never see.
 *
 * 🔴 **Why the fix is the COPY and not a restored ask.** AGENTS.md principle 14 is structural: *the
 * chat IS the channel*, a model that needs a decision ends its turn and says so, and *"do not add a
 * mode that decides whether to block; do not add a timeout and call it safe."* Attendance cannot be
 * inferred either — *"'interactive' describes how a session was CREATED, never whether anyone is
 * listening"* — which is the very failure that retired the outcome: a headless HTTP session is
 * created as `interactive`, `attendedRoot` said a human was present, and the run blocked for good.
 * Restoring an attended grant path would therefore have to re-introduce exactly the blocking
 * semantics the principle forbids. The two ends the fault offered are *restore the remedy* or
 * *rewrite the copy*; the vision picks the second, so the second is what this is.
 *
 * ⚠️ **`keys` is the mechanical half.** A sentence naming a remedy is prose, and prose drifts from
 * code silently — which is the whole defect. These are the `Config.Info` keys the remedy is spelled
 * in, and `KEY_TIERS` (`config-tier.ts`) is annotated `Record<keyof Config.Info, Tier>`, so a key
 * present there is a real, classified, ROUTED config key — `config-store-write.ts` refuses an
 * unrouted key by name. The test asserts both directions: every key here is classified, and the
 * sentence names every key. Rename the setting and the assertion fails instead of the user.
 */
export const GRANT_IN_ADVANCE = {
  /** The config keys the remedy is written in. Verified against `ConfigTier.KEY_TIERS`. */
  keys: ["permissions", "agents"] as const,
  sentence:
    `Widening this is the operator's decision and it is made IN ADVANCE, as a standing rule in the ` +
    `instance's permission settings (the \`permissions\` config key, or \`agents\` for one ` +
    `colleague's own ruleset). There is no consent prompt to answer and no way to grant it mid-run: ` +
    `this instance never interrupts anyone to ask.`,
} as const

/**
 * 1J: lower a permission failure into a model-legible message (denial as observation, never a
 * halt). Tools' blanket `mapError` absorbers call this FIRST, so a denial keeps its identity —
 * including the user's optional reject feedback — instead of collapsing into "Unable to <x>".
 */
export function denialMessage(error: unknown): string | undefined {
  if (error instanceof ProjectFileCache.FaultError) return error.message
  // A `novaclaw.json` exclusion is a refusal of the same KIND — the user said no — and it arrives
  // through the same `mapError` absorbers, so it is lowered here rather than by a line added to
  // every tool. That is what makes the refusal legible in tools nobody edited: without it, `read`'s
  // absorber would collapse it to "Unable to read <path>", which is a lie about a deliberate
  // privacy choice and exactly the dead-end AGENTS.md forbids. Enforcement lives in
  // `project-exclusion.ts`; this is only its voice.
  const excluded = ProjectExclusion.refusalMessage(error)
  if (excluded) return excluded
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
    // The FOLDER refused it, not the instance. Every other reason here describes a posture the
    // person running NovaClaw chose; this one is a file that may have arrived with a clone. So the
    // advice has to point somewhere else entirely — at `novaclaw.json`, not at the settings — and it
    // has to say that a project can only NARROW, because a model told merely "denied" will otherwise
    // spend turns trying to get the permission widened somewhere that cannot widen it.
    if (error.reason === "project-denied")
      return (
        `Permission denied: this folder's own \`novaclaw.json\` refuses action '${actions}' on ` +
        `'${resources}'. That is a PROJECT rule declared in the working folder, not a setting of this ` +
        `NovaClaw — the instance would have allowed it. A project may only ever NARROW what is permitted, ` +
        `so no change to the instance's permission settings, and no consent prompt, can widen it; only ` +
        `editing that file can, and it belongs to whoever set the folder up. Continue with what you ARE ` +
        `allowed to do, and if the task genuinely cannot finish without '${actions}', name it in your result ` +
        `together with the project file so the user can decide.`
      )
    // The one refusal on this list that no setting can lift, so the advice cannot end in "get it
    // widened". A file placed there is EXECUTED at the next boot, in this process, before any
    // NovaClaw API is consulted — so the question is not whether the agent may write a file, it is
    // whether the agent may choose what NovaClaw runs. Naming the folder matters: a model told only
    // "denied" would keep trying spellings of the same path.
    if (error.reason === "plugin-door")
      return (
        `Permission denied: '${resources}' is inside this instance's EXTERNAL PLUGIN directory, and no ` +
        `agent may write there — including this one, in any permission mode. Anything in that folder is ` +
        `imported and RUN at NovaClaw's next start, at the user's own privilege, before any permission ` +
        `check happens, so writing it would be choosing what this program executes rather than editing a ` +
        `file. This refusal is structural: no setting, mode or permission rule can lift it, and retrying, ` +
        `renaming or reaching the same folder another way will not either. If a plugin is genuinely what ` +
        `the task needs, write the file somewhere you ARE allowed to — your own project folder — and say ` +
        `in your reply where it is and what it does, so the user can install it themselves.`
      )
    if (error.reason === "project-file-invalid") return ProjectFileCache.refusal({ kind: "invalid", file: resources })
    if (error.reason === "project-file-future-version")
      return ProjectFileCache.refusal({ kind: "future-version", file: resources })
    if (error.reason === "project-file-unreadable")
      return ProjectFileCache.refusal({ kind: "unreadable", file: resources })
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
        `Continue with the tools you ARE allowed to use and finish what you can. ${GRANT_IN_ADVANCE.sentence} ` +
        `So if the task genuinely cannot finish without it, name '${actions}' in your result and stop trying it.`
      )
    // The same refusal, honestly attributed — ruling 2 in both directions. We did not establish that
    // this run is unattended; we failed to read the chain that would have told us. Saying "this is an
    // UNATTENDED session" here would be a claim about something we never checked, and it would point
    // the operator at the schedule instead of at the broken session records.
    // Owner 2026-08-20. The wording carries the ruling: consent is granted in ADVANCE or not at all,
    // scratch work belongs in the project folder, and only a genuinely blocked task should stop.
    // The measured failure was a model reaching one folder up for a notes file — it had somewhere
    // perfectly good to put it and no reason to think so.
    if (error.reason === "ask-removed")
      return (
        `Permission denied: action '${actions}' on '${resources}' is outside what this session may touch, ` +
        `and no standing rule grants it. This instance does not interrupt anyone to ask — the refusal ` +
        `arrives immediately so you can adapt instead of waiting, and retrying will not change it. ` +
        `If you need somewhere for notes, a plan, a draft or any other scratch work, use YOUR OWN ` +
        `PROJECT FOLDER — that is what it is for, and writing there needs no permission. ` +
        `If the task genuinely cannot be done inside it, say so in your result and name '${actions}' ` +
        `rather than trying again. ${GRANT_IN_ADVANCE.sentence}`
      )
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

// ─────────────────────────────────────────────────────────────────────────────
// THE PLUGIN DOOR (v0.2.0) — an agent may never write where in-process code is loaded from.
//
// 🔴 AGENTS.md principle 13's last clause: *"In-process third-party code enters through exactly one
// door — the instance config dir's plugin glob — and it must never widen to a project directory. The
// plugin contract is NOT a gate: `import()` runs module scope before anything is validated."*
// Ruling 5 (`notes/reports/decisions-v0.2.0.md` §5) kept that door open on exactly one condition,
// stated in the ruling itself: the local `{plugin,plugins}/*.ts` glob survives as *"user code at user
// privilege, unreachable by an agent, a registry or a peer."* Nothing enforced the middle clause.
// This is that clause, mechanised.
//
// ⚠️ WHY IT IS NOT COVERED BY THE ORDINARY PATH GATES, which is the part that looks wrong until you
// check it. The plugin directory sits under the instance CONFIG dir, which is outside any session's
// Location, so a write there normally spends `external_directory_write` — `ask` on the compiled
// floor, refused by the last arm. That is a DEFAULT, not a boundary, and three ordinary states walk
// through it: `MODE_RULES.yolo` allows `external_directory_write` on `*`; a session whose working
// folder IS the config dir spends plain `write`/`create`, which `bypass` allows; and a user or a
// repairing agent may write an `external_directory_write` allow into their own permission rules for
// perfectly good reasons. Every one of those is a decision about FILES. None of them is a decision to
// let an agent choose what code this process executes at its next boot, and the two must not be the
// same switch — so this is a pre-emptive DENY arm, the shape ruling 4 uses for the same reason, and
// no mode, agent ruleset, saved row or project file can soften it.
//
// ⚠️ WHAT IT DOES NOT COVER, said plainly rather than left to be discovered (ruling 2). `bash` is
// exempt because its `resource` is the raw COMMAND STRING and matching one is prompt-reduction, never
// containment (the boundary note above `evaluate`). Its redirect TARGETS are re-asserted as
// `create`/`write` against a resolved path (`tool/bash.ts` → `mutation.resolve`, `readsContent:
// false`) and ARE screened here, so `> ~/.config/novaclaw/plugin/x.ts` is refused — but `cp`, a
// heredoc inside `sh -c`, `python -c`, or `find -exec` are not, and no token scan will make them so.
// Hard confinement is the operator's boundary (Agent Jail, v0.3.0). This closes the resolved-path
// seam, which is the seam that exists; claiming more would be the false promise principle 13 names.
//
// ⚠️ NOR is it a rule about the config directory. NovaClaw's OWN writes there — settings, catalog,
// the database — are principle 11 location (a) and are the product working; they do not pass through
// this evaluator at all, and an agent writing `<config>/anything-else` is still governed by ordinary
// policy. Only the two plugin directories are removed from the negotiation.

/**
 * The directory names the external-plugin glob opens, read OFF the pattern rather than re-typed.
 *
 * 🔴 A guard that names a path in one file while the loader globs it from another is a guard with a
 * scheduled expiry — the loader moves, the guard keeps protecting the old place, and everything stays
 * green. `ConfigPluginGlob.PATTERN` is the single source, and it is a LEAF module with no imports
 * (see its header), so reading it here costs this graph nothing.
 *
 * Throws rather than guessing if the pattern stops starting with a literal `{a,b}` (or plain) segment:
 * a containment guard that silently degrades to matching nothing is worse than a boot failure.
 */
export function pluginDoorDirectories(pattern: string): readonly string[] {
  const head = pattern.split("/")[0] ?? ""
  const braced = /^\{(.+)\}$/.exec(head)
  const names = (braced ? braced[1]!.split(",") : [head]).map((name) => name.trim()).filter((name) => name.length > 0)
  if (names.length === 0 || names.some((name) => /[*?{}[\]]/.test(name)))
    throw new Error(
      `The external-plugin glob no longer begins with a literal directory segment (${pattern}); ` +
        `PermissionV2's plugin-door guard cannot derive what to protect.`,
    )
  return names
}

/** The absolute directories no agent write may land in, for one instance config dir. */
export const pluginDoors = (configDir: string): readonly string[] =>
  pluginDoorDirectories(ConfigPluginGlob.PATTERN).map((name) => path.join(configDir, name))

/**
 * The one action deliberately left unscreened, and the reason, in the place the set is built.
 * See the ⚠️ block above: a command string is not a path.
 */
const PLUGIN_DOOR_UNSCREENED_ACTIONS: ReadonlySet<string> = new Set(["bash"])

/**
 * The actions this guard screens: every host-mutating action except the one whose resource is not a
 * path. DERIVED from `HOST_MUTATING_ACTIONS` (which is itself derived from `MODE_RULES.yolo`), so a
 * new mutating action is screened the day it is added rather than the day someone remembers.
 */
export const PLUGIN_DOOR_ACTIONS: ReadonlySet<string> = new Set(
  HOST_MUTATING_ACTIONS.filter((action) => !PLUGIN_DOOR_UNSCREENED_ACTIONS.has(action)),
)

/**
 * The plugin-directory path this request would write, if any.
 *
 * ⚠️ Containment by `FSUtil.containsCanonical`, not by string prefix, and both sides are canonicalised
 * — the check `location-mutation.ts` already reasons about at length. A lexical compare would miss a
 * config dir reached through a symlinked home (`/tmp` that is really `/private/tmp`), miss a junction
 * or `subst` drive pointing INTO the plugin folder, and — since the target usually does not exist yet
 * — has to answer for a prospective path, which is what `FSUtil.canonical`'s walk-up to the nearest
 * existing ancestor is for.
 *
 * ⚠️ It reads `targets[].canonical` AND the absolute members of `resources`/`denyAliases`, because the
 * two seams speak differently: every path-shaped tool passes `targets` with a canonical path, while
 * `LocationMutation.externalDirectoryPermission` passes the canonical path as the RESOURCE and carries
 * its targets under `metadata` where this evaluator does not read them. A relative resource with no
 * target cannot be screened and is not pretended to be — that shape does not exist among today's
 * mutating asserts, and if one is ever added it must supply `targets` like every other.
 */
export function pluginDoorTarget(
  input: {
    readonly action: string
    readonly resources: readonly string[]
    readonly targets?: readonly MutationTarget[]
    readonly denyAliases?: readonly string[]
  },
  doors: readonly string[],
): string | undefined {
  if (!PLUGIN_DOOR_ACTIONS.has(input.action)) return undefined
  const candidates = [
    ...(input.targets ?? []).map((target) => target.canonical),
    ...[...input.resources, ...(input.denyAliases ?? [])].filter((resource) => path.isAbsolute(resource)),
  ]
  return candidates.find((candidate) => doors.some((door) => FSUtil.containsCanonical(door, candidate)))
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
// tie-break, and it points one way: an action wrongly LEFT OUT costs the user one permission rule
// written in advance; an action wrongly PUT IN is a gate that grants itself, which is the fault
// this baseline exists to end (ruling 2 — *a fault is never described falsely*).
// ⚠️ That price used to read "one consent card the user can answer 'always'", and it stopped being
// true when `ask` was retired as an outcome (owner, 2026-08-20 — see {@link GRANT_IN_ADVANCE}).
// Nothing about the MEMBERSHIP argument changes; the cost of getting it wrong is simply paid in the
// permission settings now, and the tie-break still points the same way.
//
//  · `read`      — file reads (`tool/read.ts`, `tool/read-hex.ts`). Cannot mutate, cannot egress.
//                  Two things still narrow it and neither is weakened by living here: a target
//                  outside the Location passes a SEPARATE `external_directory_read` assert first
//                  (`location-mutation.ts`), and a `novaclaw.json` `exclude` list is enforced at
//                  `LocationMutation.resolve`, which is BEFORE any permission rule is consulted.
//                  ⚠️ This line used to claim a third: *"`plugin/agent.ts`'s `.env` refinements sit
//                  AFTER this rule in the same ruleset, so findLast keeps them winning."* There are
//                  no such refinements — neither `plugin/agent.ts` nor `config/plugin/agent.ts`
//                  contains any rule naming `.env`, and the only `read` rule either builds is an
//                  allow on `*`. A comment describing a protection that does not exist is worse
//                  than none, because the next reader stops looking for one (ruling 2). If secret
//                  files are to be narrowed, it is unbuilt work, not a line already here.
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
//  · `websearch` — 2026-09-03, and it is `webfetch`'s ledger entry applied to `webfetch`'s WEAKER
//                  sibling. Reported from a live build: "what is the current price of gold" came back
//                  as *permission denied*. Three things make that the wrong answer rather than the
//                  documented cost of a gate:
//                  (1) COHERENCE. `webfetch` fetches an arbitrary URL and is ambient by owner ruling;
//                  `websearch` sends a query to a search engine and returns links. Allowing the
//                  stronger egress while refusing the weaker one is not a posture, it is an accident.
//                  (2) THE GATE PROMISED SOMETHING THAT DOES NOT EXIST. `tool/websearch.ts` shipped
//                  saying "on a default install this ASKS once and the answer is saveable — exactly
//                  what `webfetch`, its sibling, already does". Both halves were untrue when written:
//                  asking had been retired four days earlier, and `webfetch` was already in this list.
//                  A gate whose stated behaviour is unreachable is ruling 2 on the surface a
//                  privacy-minded user reads first.
//                  (3) PRINCIPLE 12(a), work by default. An agent that cannot answer an ordinary
//                  factual question out of the box is not a posture the user chose; it is the north
//                  star inverted — the curious non-expert meets a refusal where they expected an
//                  answer, and the remedy is a permission rule they had no way to know to write.
//                  The independent hard boundaries are UNTOUCHED and they are the real egress
//                  control: `Offline`/airgap refuses first and is not consentable (`websearch/service.ts`
//                  rule 1, "AIRGAP WINS"), the traffic governor still paces and caps, and the engine
//                  set is still the user's own SearXNG or the free metasearch — no paid API, no key.
//
// ⚠️ WHAT IS DELIBERATELY ABSENT, so the shortness is not read as an oversight. The mutation/exec
// cluster (`edit`/`write`/`create`/`trash`/`bash`) is NOT here and does not need to be: the default
// permission mode is `bypass`, whose overlay allows all five on `*` (`MODE_RULES`), so a default
// install behaves as it did. What changed is that those five are now granted by THE POSTURE THE
// USER PICKED rather than by a catch-all — which is what finally makes picking `ask` or `plan` mean
// something for everything else too. `spawn`, `kb`, `skill`, `revert`,
// `provision`, `define_tool`, `register-app`, `messenger.*`, MCP tools and ad-hoc tools each fail at
// least one of the three tests above, so on a default install they fall through to `evaluate`'s
// `ask` — which the last arm of `evaluateInput` turns into an immediate refusal, because asking was
// retired as an outcome. The cost is therefore one permission RULE per capability per install, in
// the settings, not one consent card and not one prompt per call ({@link GRANT_IN_ADVANCE}).
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
  { action: "websearch", resource: "*", effect: "allow" },
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
// AUTO MODE's self-grant is the `session_auto_grant` entity component. It is deliberately separate
// from `session.permission_mode`: the latter is the user-owned ceiling, while the former is the
// agent's narrowing inside it. The row is global and durable because the writer is a disposable
// session worker and the reader is this host evaluator; process memory made the tool report success
// while enforcing nothing. The algebra and safety proof remain in config-resolve.ts §AUTO MODE.
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

/**
 * How restrictive an effect is. `allow` < `ask` < `deny`.
 *
 * `ask` sits in the middle because it withholds the action until a human says otherwise — strictly
 * less permissive than `allow`, strictly more than a refusal.
 */
const RESTRICTIVENESS: Readonly<Record<Permission.Effect, number>> = { allow: 0, ask: 1, deny: 2 }

/**
 * The rule a ruleset has for this action/resource, or `undefined` when it has NO OPINION.
 *
 * 🔴 The distinction `evaluate` cannot make. It answers a synthetic `ask` when nothing matches, which
 * is right for a final verdict and WRONG for composition: a constraint that says nothing must change
 * nothing, and treating its silence as `ask` would let an empty project file tighten every action the
 * operator had allowed.
 */
export function matchRule(action: string, resource: string, ruleset: Permission.Ruleset): Permission.Rule | undefined {
  // `findLast`, matching `evaluate`: within ONE ruleset the later rule wins.
  return ruleset.findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource))
}

/**
 * Evaluate `base` and then let `constraints` NARROW the answer — never widen it.
 *
 * 🔴 WHY THIS EXISTS RATHER THAN ANOTHER `merge`. `evaluate` takes the LAST matching rule across the
 * concatenation, so appending a ruleset is how you OVERRIDE — including with `allow`. That is correct
 * for user config, agent config and saved answers, which are the operator speaking. It is exactly
 * wrong for a `novaclaw.json` sitting inside a folder the user may have cloned five minutes ago:
 * AGENTS.md design principle 13 requires that a Project or session may never widen the operator's safety floor,
 * and appending would hand a repository author a `{"*": "*": "allow"}` past every deny in the install.
 *
 * So a constraint can only move the verdict UP the restrictiveness order, and a constraint with no
 * matching rule leaves it untouched.
 *
 * ⚠️ The returned rule keeps the ORIGIN of whichever verdict won, so a caller can tell the user which
 * file denied them. A composed verdict that cannot name its author is one nobody can act on.
 */
export function evaluateNarrowed(
  action: string,
  resource: string,
  base: Permission.Ruleset[],
  constraints: Permission.Ruleset[],
): Permission.Rule {
  let winner = evaluate(action, resource, ...base)
  for (const constraint of constraints) {
    const rule = matchRule(action, resource, constraint)
    if (!rule) continue
    if (RESTRICTIVENESS[rule.effect] > RESTRICTIVENESS[winner.effect]) winner = rule
  }
  return winner
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Permission") {}

export const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const location = yield* Location.Service
    // ⚠️ Through `Global.Service`, NEVER `Global.Path.config` — that is the difference between
    // guarding the door and guarding a directory next to it. `Global.make()` applies
    // `NOVACLAW_CONFIG_DIR` and `Global.Path` does not, and the loader this guard shadows
    // (`config/plugin/external.ts`) reads the service. Two readers of one location that resolve it
    // differently is the failure `tool/tool-manual.ts` records from the other side; here the
    // disagreement would be silent AND load-bearing — the guard would protect an empty folder while
    // the loader read the one the agent just wrote to. Resolved once, at layer build.
    const pluginDoorDirs = pluginDoors((yield* Global.Service).config)
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const projects = yield* ProjectFileCache.Service
    const effective = yield* SessionEffectiveConfig.Service
    /**
     * A session's Project permissions.
     *
     * 🔴 They are a NARROWING constraint, never part of the appended chain. `evaluate` takes the last
     * match, so appending would let a `novaclaw.json` — a file inside a folder the user may have
     * cloned minutes ago — override an operator deny with `allow`. See `evaluateNarrowed`.
     *
     * ⚠️ Resolved from the SESSION's working folder, not this location's directory. The two differ
     * whenever a session was opened somewhere else, and the folder the agent is actually working in
     * is the one whose project governs it (*"the nearest valid `novaclaw.json`
     * at or above the session folder"*). Reading the location's directory answered for the instance
     * no matter whose folder was asked about — correct only while every session sits in the
     * instance's own folder, which is not a property the kernel has. The direction of the change is
     * worth naming: a session working outside a project now carries no project constraint, where it
     * used to inherit the instance folder's. That is the honest reading of a narrowing rule set —
     * it belongs to a folder, and a session that left the folder left its rules.
     *
     * ⚠️ The read itself lives in `ProjectFileCache` so the rules and the tune come from ONE read of
     * one file. Two caches over one file can disagree across a mid-window edit and apply a folder's
     * rules without its stance.
     */
    const sessionDirectory = EffectRuntime.fnUntraced(function* (sessionID: SessionV2.ID) {
      const session = yield* sessions.get(sessionID)
      // A session that vanished mid-evaluation gets the location's own folder rather than none: the
      // fallback direction for a narrowing constraint must be the stricter one.
      return session?.location.directory ?? location.directory
    })
    const projectEntry = EffectRuntime.fnUntraced(function* (sessionID: SessionV2.ID) {
      // The session's own folder is both the question and the trust root here.
      const directory = yield* sessionDirectory(sessionID)
      return yield* projects.read(directory, directory)
    })

    const autoGrants = yield* SessionAutoGrant.Service
    const saved = yield* PermissionSaved.Service

    /**
     * The durable saved-grant table, folded in after the agent ruleset and the mode overlay.
     *
     * ⚠️ **Nothing a user can reach from a CHAT writes it, and every comment here that assumes
     * otherwise is wrong.** `PermissionSaved.add` lost its only caller when `ask` was retired as an
     * outcome (owner, 2026-08-20), and the HTTP surface exposes `permission.saved.list` and
     * `permission.saved.remove` and no add. What can still write a row is the Developer-mode
     * Registry app editing the `permission` table by hand — a human on their own machine, which is
     * ruling 5's trust boundary working as designed — and an AGENT may not, which round 1 made a
     * refusal in `db-registry.ts` (`PERMISSION_KERNEL_TABLES`). So the read stays: revoking or
     * inspecting a grant is a real repair. What must NOT come back is denial copy telling a model to
     * get a row written by answering something — see {@link GRANT_IN_ADVANCE}.
     */
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
      // ⚠️ A PAUSED colleague is denied exactly as a missing one is, and deliberately reuses the same
      // ruleset rather than a second deny-all: `disabled: true` used to delete the agent outright, so
      // `resolve` returned undefined and this line already answered deny-`*`-on-`*`. Pausing keeps
      // the colleague on the roster (its chat reachable, its id held, its cabinet its own) WITHOUT
      // changing what it may do, which is only true if both arms give the same verdict.
      if (agent?.paused === true) return missingAgentPermissions
      return agent?.permissions ?? missingAgentPermissions
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return [...input.resources, ...(input.denyAliases ?? [])].some(
        (resource) => evaluate(input.action, resource, rules).effect === "deny",
      )
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    // The whole resolved config, not just the mode: the evaluator also needs the surgical-edits
    // switch. Through `SessionEffectiveConfig`, which is the ONE place the folder's stance is folded
    // in — a layer BENEATH the entity, supplying a component no session on the chain declared and
    // losing to every one that does (`ProjectDefaults.WIRED` gates which components that reaches).
    const sessionConfig = (sessionID: SessionV2.ID) => effective.resolve(sessionID)

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      // ── THE PLUGIN DOOR, first and unconditional (see §THE PLUGIN DOOR above) ─────────────────
      //
      // FIRST because it is the one arm that depends on nothing — not the mode, not the chain, not
      // the project file — and because being reachable only after some other arm declines is exactly
      // how a hard gate turns into a default. It reads only the request, so it costs one set lookup
      // for every non-mutating action and cannot be softened by anything below it.
      const pluginDoorHit = pluginDoorTarget(input, pluginDoorDirs)
      if (pluginDoorHit !== undefined)
        return {
          effect: "deny" as const,
          // The synthetic rule's resource is the PATH, not the request's own resource string, so the
          // message names the file the user would have to look at — the same choice the project-file
          // fault arm makes below, for the same reason.
          rules: [{ action: input.action, resource: pluginDoorHit, effect: "deny" as const }],
          reason: "plugin-door" as DenialReason | undefined,
        }

      // ── THE CEO's FLOOR, immediately after it ─────────────────────────────────────────────────
      //
      // Owner, 2026-09-02: "Nova itself should have full permission for everything… i.e. it lacking
      // permission is not an option." Authority narrows DOWNWARD from the CEO (AGENTS.md, the
      // structural metaphor), so a rule that narrows the top has inverted the org chart.
      //
      // ABOVE every arm below it — configured rules, the resolved mode, the attendance chain, and
      // the project file's NARROWING constraint — because each of those is something a rule or a
      // repository can say, and this is the shape of the organization rather than a setting. A
      // `novaclaw.json` in a folder somebody cloned five minutes ago may narrow any colleague; it
      // does not get to narrow the instance's own CEO.
      //
      // ⚠️ BELOW the plugin door, and that ordering is deliberate rather than an oversight. That
      // gate is not a permission tier: it is the single place in-process third-party code can enter,
      // and `import()` runs module scope before anything validates it. No authority level was ever
      // meant to open it, and a Nova carrying an injected instruction is precisely the case it
      // exists for. Everything a colleague could be granted, Nova has; the one thing nobody is
      // granted stays nobody's.
      if (AgentV2.hasFullAuthority(input.agent))
        return {
          effect: "allow" as const,
          rules: [] as Permission.Ruleset,
          reason: undefined as DenialReason | undefined,
          attachment: undefined,
        }
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
      // The chain walk is skipped while the component table is empty, so a default install pays
      // one existence query rather than one lookup per ancestor.
      // ⚠️ It folds the whole CHAIN, not just this session, which is what makes a parent's
      // self-revocation reach the children it spawns afterwards (todo.md → Vision → *Privilege
      // self-revocation*: "drops capabilities from itself AND ITS CHILDREN"). A child resolves its
      // mode from the parent's stored ROW, and a self-grant deliberately never touches that row, so
      // without this fold the revocation would be escapable by spawning.
      const chainGrant = (yield* autoGrants.any())
        ? yield* chainAutoGrant(input.sessionID, (id) => sessions.get(id as SessionV2.ID), autoGrants.mode)
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
      // A present-but-unusable project file is a constraint we cannot read, never an empty one.
      // Refuse before any model-authored action and name the exact remedy. The synthetic rule's
      // resource is the FILE (not the requested target) so the shared denial voice can identify
      // what the user must fix, upgrade for, or unlock.
      const project = yield* projectEntry(input.sessionID)
      const projectFault = ProjectFileCache.fault(project)
      if (projectFault !== undefined)
        return {
          effect: "deny" as const,
          rules: [{ action: input.action, resource: projectFault.file, effect: "deny" as const }],
          reason: PROJECT_FILE_DENIAL_REASON[projectFault.kind],
        }
      // The mode overlay, plus Analyze's one carve-out. "Analyze" (mode `plan`) is read-only EXCEPT that it
      // may still write its findings somewhere — a review that cannot save its own report is not much use.
      // The allows land AFTER the mode denies (findLast) so they apply to the temp dir and nowhere else, and
      // they are folded into the same array the early deny-fast arm checks, or that arm would refuse the
      // write before ever seeing the exception.
      const modeRules = modeRulesFor(mode)
      // The two Tuning switches that were once modes. Both NARROW whatever mode is active and never widen
      // it, so they sit after the mode overlay and are included in the deny-fast arm below. Both default
      // OFF (no global `{ enabled }` block to inherit from), which is why absent means "do not apply".
      const featureRules = featureRulesFor(resolved)
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
      // answer is not protection — durable consent survives a restart now, but it cannot conjure an
      // operator for an unattended chain. `yolo` stays the one deliberate way out, matching
      // `unattendedStanceRules`.
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
      // ⚠️ `evaluateNarrowed`, not `evaluate`. Every early return above is a DENY, which a project
      // cannot narrow further, so this is the one place a Project's rules can change an answer — and
      // they can only make it stricter.
      // Resolved ONCE per evaluation, not per resource: a multi-resource assert must be judged
      // against ONE view of the file, or two resources in the same call could be answered from
      // either side of an edit.
      const projectRules = project.rules
      const effects = input.resources.map(
        (resource) => evaluateNarrowed(input.action, resource, [all], [projectRules]).effect,
      )
      const aliasDenied = (input.denyAliases ?? []).some(
        (resource) => evaluateNarrowed(input.action, resource, [all], [projectRules]).effect === "deny",
      )
      // Did the PROJECT do this, or would it have been refused anyway? Compared against the same
      // resources WITHOUT the constraint, because "the project denied it" is only true when nothing
      // else would have — telling a user to go read a file that changed nothing is worse than
      // saying nothing, and it is the kind of wrong pointer that costs an afternoon.
      const projectDenied =
        projectRules.length > 0 &&
        effects.includes("deny") &&
        !input.resources.some((resource) => evaluate(input.action, resource, all).effect === "deny")
      const evaluated: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      const effect: Permission.Effect =
        aliasDenied || evaluated === "deny" || input.minimumEffect === "deny"
          ? "deny"
          : evaluated === "ask" || input.minimumEffect === "ask"
            ? "ask"
            : "allow"
      // ── AN ASK NOBODY CAN ANSWER IS A HANG, NOT A GATE — the B4c follow-up ────────────────────
      //
      // This is the LAST arm on purpose: everything that could legitimately answer for the action
      // has already spoken — the read baseline, the agent's configured rules, the mode
      // overlay, the Tuning switches, the stance, and saved answers. Only after
      // all of that resolves to `ask` do we know that NOBODY ruled on this action, which is exactly
      // the state B4c created by design: the compiled floor is an allowlist now
      // (`AMBIENT_SAFE_BASELINE`), so `spawn`, `skill`, `kb`, `websearch`, `revert`, `provision`,
      // `define_tool`, `register-app`, `messenger.*`, every MCP tool and every ad-hoc tool a model
      // invents at runtime fall through to `evaluate`'s `ask` default. (⚠️ `webfetch` and `js` were
      // in that list until 2026-08-04, when the owner promoted both INTO the baseline. Read the
      // constant, never this sentence — a stale example here left five tests red for a day.)
      //
      // Under an UNATTENDED chain that ask parks on a consent card nobody will ever answer. Persisting
      // the card fixes attended restart recovery; it does not fix the absence of an operator. The
      // measured pathology is "the run looking alive and doing nothing". The stance's own doctrine
      // already rules on it
      // (`config-resolve.ts` §UNATTENDED CONFINEMENT: *an ask nobody is present to answer is a
      // HANG, not a gate*), so the honest answer is an IMMEDIATE refusal the model can route
      // around, with its own reason so the wording can be actionable.
      //
      // ⚠️ WHY THERE IS NO `yolo` EXEMPTION HERE, unlike `unattendedStanceRules` and the attachment
      // arm above. Those two convert a GRANT into a refusal, so the mode that means "everything"
      // has to be the way out of them. This arm converts nothing: reaching it means the action was
      // never granted, in any mode — `MODE_RULES.yolo` names only the mutation cluster and the two
      // external classes, so an unattended `yolo` root calling any of them was hanging too. A mode
      // is a statement about capability; attendance is a statement about who can answer, and `yolo`
      // cannot conjure an operator. Exempting it would preserve a hang in the name of a grant
      // nobody made.
      //
      // ⚠️ AND THIS IS NOT A NEW BOUNDARY — it converts a verdict, it never creates one. Anything
      // resolving to `allow` above is untouched (in-folder work, reads, `explore`, `todowrite`, the
      // whole mutation/exec cluster under the default `bypass`), and the way to give an unattended
      // run a gated capability is unchanged and stated in the denial text: grant it in ADVANCE, as
      // an agent or instance permission rule ({@link GRANT_IN_ADVANCE}). The self-healing law is
      // untouched — that is a runtime-editable store.
      // ⚠️ This sentence named a second path — *one "always" answer in an attended chat* — until
      // 2026-09-02, and the denial text it points at named it too. There is no such path: retiring
      // `ask` removed the only caller of `PermissionSaved.add`, so nothing a user can reach from a
      // chat writes the saved-grant table. A remedy the code cannot perform is ruling 2 broken by
      // the very text written to satisfy it, which is exactly what this arm's own comment warns of
      // two paragraphs down.
      //
      // The synthetic rules appended to `rules` ARE the verdict this arm reached, in the vocabulary
      // `denialMessage` reads — one per requested resource, because the call is refused for all of
      // them. `evaluate` already synthesises `{action, resource: "*", effect: "ask"}` when no rule
      // matches, so this is that rule with the verdict this arm gives it. Without them `relevant()`
      // would hand the error an EMPTY ruleset for a fall-through action (no compiled rule names it,
      // by definition) and the message would report the action AND the resource as "unknown" — ruling
      // 2 broken by the very text written to satisfy it. Per-resource rather than `*` so the model is
      // told WHICH url/command/path was refused, not just which verb.
      // 🔴 The attendance condition is GONE (owner ruling 2026-08-20). It read
      // `effect === "ask" && !attendedRoot(rootType)` and did not fire on the failure that prompted
      // this: a headless HTTP session is created as `interactive`, so `attendedRoot` said a human was
      // present when none was, and the run blocked on the ask for good. Attendance is a property of
      // who is WATCHING, and the session type cannot know it.
      //
      // The three reasons stay separate because they prescribe different actions: an unattended run
      // wants a grant made in advance, an unreadable chain wants its session records fixed, and this
      // one is simply the policy.
      if (effect === "ask")
        return {
          effect: "deny" as const,
          rules: [
            ...all,
            ...input.resources.map((resource) => ({ action: input.action, resource, effect: "deny" as const })),
          ],
          reason: (attendedRoot(rootType)
            ? "ask-removed"
            : rootType === "unknown"
              ? "unanswerable-chain-unreadable"
              : "unattended-unanswerable") as DenialReason | undefined,
        }
      return {
        effect,
        rules: all,
        reason: (effect === "deny" && projectDenied ? "project-denied" : undefined) as DenialReason | undefined,
        attachment: protecting ? attachment : undefined,
      }
    })

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      return { id: input.id ?? ID.create(), effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      if (result.effect !== "deny") return
      return yield* new DeniedError({
        rules: relevant(input, result.rules),
        ...(result.reason ? { reason: result.reason } : {}),
      })
    })

    return Service.of({ ask, assert })
  }),
)

// `Global.layer` is provided here rather than left in `R`: the guard above put `Global.Service` into
// this layer's requirements, and an exported layer that silently grows one hands its next caller a
// type error in a file they did not touch. Global is a pure value read off the environment, so a
// second instance of it is the same instance.
export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer), Layer.provide(Global.layer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Location.node,
    // The instance config dir, for the plugin-door guard. A dependency-free global node that every
    // instance already builds, so this adds a reference and not a subsystem.
    Global.node,
    AgentV2.node,
    SessionStore.node,
    PermissionSaved.node,
    SessionAutoGrant.node,
    // The session's `novaclaw.json`: its rules here, its tune through the effective-config entry
    // point. Both are GLOBAL nodes already built in every instance, so this adds references rather
    // than new subsystems to the boot order.
    ProjectFileCache.node,
    SessionEffectiveConfig.node,
  ],
})
