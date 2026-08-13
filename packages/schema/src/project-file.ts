export * as ProjectFile from "./project-file"

import { Schema } from "effect"
import { Permission } from "./permission"

/**
 * `novaclaw.json` — the portable declaration that a folder is a NovaClaw **Project**.
 *
 * `todo/projects.md`: a folder becomes a Project when it contains a valid `novaclaw.json`; before
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
 * budget). `todo/projects.md` means the FIRST — "a fresh chat in the folder starts with its Tune" is
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

/** What a folder may declare about itself. Every section optional: an empty project is still valid. */
export const Info = Schema.Struct({
  version: Schema.Number,
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
  /** IDs of installed pre-action policies. ⛔ IDs only — never a command, and never anything run. */
  policies: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Project.File" })
export type Info = typeof Info.Type

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
    return { ok: false, reason: "not-an-object", detail: `expected an object, found ${Array.isArray(value) ? "an array" : typeof value}` }
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
  if (decoded._tag === "Failure")
    return { ok: false, reason: "not-an-object", detail: String(decoded.failure) }
  return { ok: true, info: decoded.success, raw }
}

/**
 * Apply `changes` to the file's raw object, preserving everything this build does not understand.
 *
 * 🔴 THE POINT OF THE RAW OBJECT. `todo/projects.md` requires that a newer file edited by an older
 * NovaClaw keeps its unknown fields. Serialising the DECODED view would silently delete every
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

/** One switch on the composer's Tuning panel. */
export type TuneFeature = keyof NonNullable<Tune["features"]>

/** Whether a switch is supervision (raise-only) rather than preference (either way). */
export const isSupervisionFeature = (feature: TuneFeature): boolean =>
  (SUPERVISION_FEATURES as readonly string[]).includes(feature)
