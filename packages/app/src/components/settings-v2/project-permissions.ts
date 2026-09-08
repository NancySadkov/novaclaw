import type { TranslationKey } from "@/context/language"
import type { ProjectPermissionRule, ProjectState } from "@/utils/project-api"

/**
 * **The decisions the Project permissions surface makes, out of the JSX.**
 *
 * The brief: *"make Permissions expose the Project defaults loaded from `novaclaw.json`,
 * distinguish them from personal and session rules, and save Project-default edits back to only the
 * Permissions section."*
 *
 * 🔴 **Two of these rules are surprising, and a surprising rule rendered inline is one that goes
 * quietly wrong.** Same reasoning as `composer/make-default.ts`, which this file is the twin of:
 *
 *  1. **An `allow` rule in a project file does nothing, ever.** The kernel folds a project's ruleset
 *     in as a NARROWING constraint (`PermissionV2.evaluateNarrowed`), which replaces the base verdict
 *     only with something strictly more restrictive. `allow` is the least restrictive effect there
 *     is, so it can never win. A control that offered to save one would be a control that reports
 *     success and changes nothing — so the surface must be able to say, before the button, which
 *     rules will land and which will not.
 *  2. **A `.gitignore` is not a "never read" list.** One says what should not be committed, the
 *     other what a model may never see. They overlap on `.env` and disagree on `dist/`, and
 *     equating them silently is the named failure.
 *
 * ⚠️ The server is the ENFORCEMENT for (1) — it drops an `allow` and reports it in
 * `refusedPermissions`, so the file is never wrong even if this copy drifts. This exists so the
 * screen can explain what will happen instead of apologising for it in a receipt.
 */

/**
 * Where a rule in force came from. Three, and they are the answer to *"who refused me"*.
 *
 * 🔴 They are separate because the REMEDY differs, which is the same reason `PermissionV2`'s
 * `DenialReason` gives `project-denied` its own literal: a project rule lives in a file in the
 * folder — possibly written by whoever the user cloned it from — and is fixed by editing that file;
 * a personal rule is a saved answer the user gave and is fixed here; a chat's rules come from its
 * own Mode and Tuning switches and are fixed in that chat. A screen that showed one merged list
 * would send two thirds of its readers to the wrong place.
 */
export const PERMISSION_ORIGINS = ["project", "personal", "session"] as const
export type PermissionOrigin = (typeof PERMISSION_ORIGINS)[number]

export interface ProjectPermissionPlan {
  /** Every rule the surface holds, in file order. */
  readonly declared: readonly ProjectPermissionRule[]
  /** Of those, what a save would actually put in the file. */
  readonly persisted: readonly ProjectPermissionRule[]
  /**
   * Of those, what would be dropped: an `allow` cannot narrow anything, so the reader ignores it.
   *
   * Named `omitted` rather than `invalid` on purpose — the rule is not malformed, it is inert, and
   * telling a user their rule is wrong when it is merely powerless is a different (false) sentence.
   */
  readonly omitted: readonly ProjectPermissionRule[]
}

/** The effects a project file may usefully declare, in escalating restrictiveness. */
export const PROJECT_RULE_EFFECTS = ["ask", "deny"] as const
export type ProjectRuleEffect = (typeof PROJECT_RULE_EFFECTS)[number]

export function planProjectPermissions(rules: readonly ProjectPermissionRule[]): ProjectPermissionPlan {
  const omitted = rules.filter((rule) => rule.effect === "allow")
  return { declared: rules, persisted: rules.filter((rule) => !omitted.includes(rule)), omitted }
}

/**
 * The payload for a Project-permissions save.
 *
 * ⚠️ Sends `declared`, not `persisted` — deliberately, and for the reason `makeDefaultPayload`
 * spells out: the SERVER decides what may be recorded and reports what it dropped. A client that
 * pre-filtered would make `refusedPermissions` permanently empty, which is the client agreeing with
 * itself instead of being told.
 *
 * ⚠️ An empty list becomes a `clear`, never `permissions: []`. `[]` and no key at all read the same
 * to the kernel, and leaving a `"permissions": []` line in the user's file after they removed their
 * last rule is a sentence that says nothing — the file should stop mentioning it.
 */
export function projectPermissionsPayload(plan: ProjectPermissionPlan): {
  readonly permissions?: readonly ProjectPermissionRule[]
  readonly clear?: readonly "permissions"[]
} {
  if (plan.declared.length === 0) return { clear: ["permissions"] }
  return { permissions: plan.declared }
}

/**
 * Whether a rule a user is composing is worth offering to save.
 *
 * A blank action or resource is not a rule, and `*`/`*` with `deny` is a folder that refuses
 * everything — legal, occasionally meant, and not something to block. Only emptiness is refused.
 */
export function ruleIsComplete(rule: { action: string; resource: string }): boolean {
  return rule.action.trim().length > 0 && rule.resource.trim().length > 0
}

/** A rule with its parts trimmed, as it will be written. */
export function normalizeRule(rule: ProjectPermissionRule): ProjectPermissionRule {
  return { action: rule.action.trim(), resource: rule.resource.trim(), effect: rule.effect }
}

/**
 * Whether the file governing this folder IS this folder's own.
 *
 * 🔴 **Why every write control has to ask.** `POST /api/project` writes
 * `<routed directory>/novaclaw.json` and never the ancestor the read resolved to — correctly, because
 * "make this folder's defaults" must not silently change every sibling checkout under a shared
 * parent. But `ProjectFileResolve.walk` stops at the NEAREST valid file, so creating one in a
 * subfolder makes the ancestor's file stop governing this folder *entirely* — its exclusions and its
 * Tune along with its permissions. Editing an inherited list here would therefore look like "adding
 * two patterns" and actually be "replacing the whole inherited declaration with these two patterns".
 *
 * ⚠️ Compared through {@link pathKey}, never `===`: the two strings come from different places (the
 * browser's session record and the server's `path.resolve`), so they can differ in separator style or
 * a trailing slash while naming one directory. A raw comparison tells the user their edit will create
 * a new file when it is about to update the one in front of them.
 */
export function governedHere(state: ProjectState | undefined, directory: string): boolean {
  return state?.kind === "project" && pathKey(state.root) === pathKey(directory)
}

/** Two names for one directory, folded. Separator style and a trailing slash are not differences. */
export const pathKey = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()

export type GitignoreImportState =
  /** No project file, so there is nothing to import INTO. */
  | { readonly kind: "no-project" }
  /**
   * The governing file is in a folder ABOVE this one, so importing here would not extend its list —
   * it would create a second project file that shadows the first. Offered as an explanation, not a
   * control.
   */
  | { readonly kind: "elsewhere"; readonly file: string }
  /** A project, but no `.gitignore` beside it. */
  | { readonly kind: "no-file" }
  /** A `.gitignore` exists and every line in it is already covered. */
  | { readonly kind: "nothing-new"; readonly file: string; readonly already: number }
  /** There is something to propose. */
  | {
      readonly kind: "ready"
      readonly file: string
      readonly add: readonly string[]
      readonly already: readonly string[]
      readonly dropped: readonly { readonly source: string; readonly reason: string }[]
      readonly reincludes: readonly string[]
      /** The `exclude` list a confirmation would write: the current one, then the additions. */
      readonly exclude: readonly string[]
    }

/**
 * What the import control can offer, given the resolved project state.
 *
 * 🔴 **Five states, not two.** *"No `.gitignore` here"*, *"everything in it is already covered"* and
 * *"here is what it would add"* are three different things to tell a person, and collapsing the
 * first two into a hidden control is how a capability teaches nobody it exists (principle 12d: say
 * what is in force right now). The fourth is the plain absence of a project; the fifth is a
 * declaration that lives in a folder above this one, which is an explanation rather than a control.
 *
 * ⚠️ **Appended, never merged or sorted.** `exclude` resolves by LAST MATCH, so the array's order is
 * its meaning: the user's own lines keep their place and their precedence, and the import lands
 * after them. That is also the only order a person can reason about afterwards.
 */
export function gitignoreImport(state: ProjectState | undefined, directory: string): GitignoreImportState {
  if (!state || state.kind !== "project") return { kind: "no-project" }
  // 🔴 Before anything else: an import into a folder whose declaration lives ABOVE it would create a
  // second file that shadows the first, taking the ancestor's Tune and permissions out of force as a
  // side effect of adding two path patterns. See `governedHere`.
  if (!governedHere(state, directory)) return { kind: "elsewhere", file: state.file }
  const proposal = state.gitignore
  if (!proposal) return { kind: "no-file" }
  if (proposal.add.length === 0)
    return { kind: "nothing-new", file: proposal.file, already: proposal.already.length }
  return {
    kind: "ready",
    file: proposal.file,
    add: proposal.add,
    already: proposal.already,
    dropped: proposal.dropped,
    reincludes: proposal.reincludes,
    exclude: [...state.exclude, ...proposal.add],
  }
}

/**
 * What an exclusion-list edit will write.
 *
 * ⚠️ Same shape as {@link projectPermissionsPayload}, and for the same reason: an empty list becomes
 * a `clear`, never `exclude: []`. Leaving `"exclude": []` behind after the user removed their last
 * pattern is a line in their file that says exactly what no line says — and, worse, it reads on a
 * later visit as *"someone configured this to be empty"* rather than *"nobody has set one"*.
 */
export function projectExcludePayload(patterns: readonly string[]): {
  readonly exclude?: readonly string[]
  readonly clear?: readonly "exclude"[]
} {
  const cleaned = patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
  if (cleaned.length === 0) return { clear: ["exclude"] }
  return { exclude: cleaned }
}

/**
 * Every key this surface can ask for, for the test that pins them against `en.ts`.
 *
 * ⚠️ A missing key does not throw — `t()` hands back the key behind a signature claiming `string`,
 * so a user reads `settings.permissions.project.origin.project` where a sentence should be. The
 * type check catches a key that was never in `en`; this list catches one removed from it later.
 */
export const projectPermissionKeys: readonly TranslationKey[] = [
  "settings.permissions.project.title",
  "settings.permissions.project.description",
  "settings.permissions.project.inForce.none",
  "settings.permissions.project.inForce.here",
  "settings.permissions.project.inForce.ancestor",
  "settings.permissions.project.origin.project",
  "settings.permissions.project.origin.personal",
  "settings.permissions.project.origin.session",
  "settings.permissions.project.origin.projectDetail",
  "settings.permissions.project.origin.personalDetail",
  "settings.permissions.project.origin.sessionDetail",
  "settings.permissions.project.narrowing",
  "settings.permissions.project.empty",
  "settings.permissions.project.personalEmpty",
  "settings.permissions.project.remove",
  "settings.permissions.project.add",
  "settings.permissions.project.addAction",
  "settings.permissions.project.addResource",
  "settings.permissions.project.omitted",
  "settings.permissions.project.save",
  "settings.permissions.project.saving",
  "settings.permissions.project.preview",
  "settings.permissions.project.previewClear",
  "settings.permissions.project.receipt.updated",
  "settings.permissions.project.receipt.created",
  "settings.permissions.project.receipt.cleared",
  "settings.permissions.project.receipt.preserved",
  "settings.permissions.project.receipt.preservedNone",
  "settings.permissions.project.receipt.refused",
  "settings.permissions.project.receipt.refusedBroken",
  "settings.permissions.project.receipt.refusedFuture",
  "settings.permissions.project.receipt.untouched",
  "settings.permissions.project.receipt.failed",
  "settings.permissions.project.inForce.ancestorEdit",
  "settings.project.exclude.editTitle",
  "settings.project.exclude.elsewhere",
  "settings.project.exclude.import.elsewhere",
  "settings.project.exclude.editDescription",
  "settings.project.exclude.addPattern",
  "settings.project.exclude.add",
  "settings.project.exclude.remove",
  "settings.project.exclude.preview",
  "settings.project.exclude.previewClear",
  "settings.project.exclude.save",
  "settings.project.exclude.saving",
  "settings.project.exclude.import.title",
  "settings.project.exclude.import.distinct",
  "settings.project.exclude.import.noFile",
  "settings.project.exclude.import.nothingNew",
  "settings.project.exclude.import.preview",
  "settings.project.exclude.import.already",
  "settings.project.exclude.import.dropped",
  "settings.project.exclude.import.reincludes",
  "settings.project.exclude.import.action",
  "settings.project.exclude.import.saving",
  "settings.project.exclude.import.done",
]
