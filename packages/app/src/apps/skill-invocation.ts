import { SkillInvocation } from "@novaclaw/core/skill/invocation"
import type { Enablement, PermissionRule } from "./skills"

// The Skills app's INVOCATION controls, kept out of the page so every state is unit-testable:
// each of the four switch combinations, a skill whose name cannot be addressed, a skill already
// refused by a broader rule of the user's own, and a saved choice whose skill is gone.
//
// The decision itself lives ONE level down, in `@novaclaw/core/skill/invocation` — imported rather
// than restated, because the kernel gate (`command/list.ts`) and this page must agree about what a
// stable skill id IS. `apps/skills.ts` re-implements `wildcardMatch` on purpose (it has to drop a
// `process.platform` read the browser cannot make); nothing here has that excuse, so a second copy
// would just be a second answer.
//
// ⚠️ **The two switches are not symmetric in force, and this module keeps that difference legible
// rather than smoothing it away.** "Nova may choose this" is a permission rule: off means the skill
// is never mentioned to an agent AND is refused if one names it anyway. "Show it for me to run" is
// your own menu: off means it stops appearing in the slash popover, and typing the exact name still
// works. Presenting them as twins would tell the user that hiding a skill keeps the agent off it.

export type { Enablement, PermissionRule }

/** What the two switches are doing right now, plus everything the page needs to say why. */
export interface InvocationView {
  /** The "Nova may choose this" switch position. */
  readonly nova: boolean
  /**
   * The "Show it for me to run" switch position — the USER's own answer, project or no project.
   *
   * ⚠️ Deliberately not the folded one. A folder that hides a skill must not make this switch read
   * "off", because then it would appear to have been moved by a repository and moving it back would
   * appear not to work. {@link InvocationView.hiddenByProject} carries the folder's statement, and
   * {@link InvocationView.effectiveMe} is what the slash menu actually does.
   */
  readonly me: boolean
  /** Whether the folder's `novaclaw.json` hides this skill from the slash menu. */
  readonly hiddenByProject: boolean
  /**
   * Whether it is in the slash menu right now, both layers folded — `me && !hiddenByProject`.
   *
   * This is what `CommandList` serves, and it is what the "right now" line must describe.
   */
  readonly effectiveMe: boolean
  /** Which layer produced {@link effectiveMe}. Principle 12(d): a user must be able to tell. */
  readonly meBy: SkillInvocation.ShownBy
  /**
   * The name for the pair of SWITCHES — a LABEL derived from the two booleans, never a stored third
   * state. This is what the "Only when I choose it" button compares itself against.
   *
   * ⚠️ NOT the sentence that says what is in force. See {@link inForce}.
   */
  readonly preset: SkillInvocation.Preset
  /**
   * The name for what is ACTUALLY happening, folder included — `presetOf({nova, me: effectiveMe})`.
   *
   * 🔴 **Found by running it, not by a test.** Principle 12(d) asks for *what is in force right
   * now*, before any control, and the first cut used {@link preset} for that line. On a skill the
   * folder hides, the page then read *"it is in your slash menu for you to run"* directly above
   * *"this folder keeps this skill out of your slash menu"* — a sentence contradicted by the next
   * one, which is the fault-described-falsely shape with two sentences instead of none. The unit
   * tests were green: they asserted the preset, which was correctly reporting the switches.
   *
   * So the in-force line describes the OUTCOME and {@link preset} keeps describing the controls.
   * They differ only while a folder overrides the user, which is exactly when the difference is the
   * thing the reader needs.
   */
  readonly inForce: SkillInvocation.Preset
  /** True when the pair is exactly the "Only when I choose it" preset. */
  readonly isOnlyWhenIChoose: boolean
  /** The stable id, when this skill's name can be written down at all. */
  readonly id?: string
  /** Why it cannot, when it cannot. Both switches are then unavailable and the page says why. */
  readonly locked?: SkillInvocation.UnaddressableReason
  /**
   * Every agent refuses this skill even though OUR per-skill rule is not what did it.
   *
   * 🔴 The one state where an honest control must contradict its own switch. The user's ruleset can
   * carry a broader `skill` deny (a wildcard, or a rule on another pattern this name matches), and
   * `evaluate` takes the last match — so "Nova may choose this: on" would be a switch that reads as
   * a grant while the engine refuses every call. We show the switch where it is AND say the skill is
   * refused anyway, pointing at the section that already reports it per agent.
   */
  readonly blockedElsewhere: boolean
}

export interface InvocationInput {
  readonly name: string
  /** The instance's `permissions` ruleset, exactly as `config.permissions` carries it. */
  readonly rules: readonly PermissionRule[]
  /** `config.skill_invocation`. */
  readonly store: SkillInvocation.Store | undefined
  /**
   * The skill ids the session folder's `novaclaw.json` hides — `GET /api/project`'s `skills`.
   *
   * ⚠️ Already narrowed by the server: a folder asking to SHOW a skill never appears here, because
   * a project may hide and may never un-hide. `undefined` means "no project, or not asked".
   */
  readonly projectHidden?: readonly string[]
  /** What `apps/skills.ts` already computed per agent — our only view of the WHOLE ruleset. */
  readonly enablement: Enablement
}

export function invocationOf(input: InvocationInput): InvocationView {
  const identity = SkillInvocation.identify(input.name)
  const nova = !SkillInvocation.deniedByName(input.rules, input.name)
  const seen = SkillInvocation.visibility(input.store, input.projectHidden, input.name)
  const me = seen.instance
  // ⚠️ The PRESET names the pair of SWITCHES, not the folded outcome. It labels what the two
  // controls on this page say, and a folder's file moves neither of them — folding it in here would
  // print "Right now: neither" over two switches both reading "on", which is the confident-falsehood
  // shape. The folder's own sentence is a separate line; see `hiddenByProject`.
  const state = { nova, me }
  return {
    nova,
    me,
    hiddenByProject: seen.project,
    effectiveMe: seen.show,
    meBy: seen.by,
    preset: SkillInvocation.presetOf(state),
    inForce: SkillInvocation.presetOf({ nova, me: seen.show }),
    isOnlyWhenIChoose:
      nova === SkillInvocation.ONLY_WHEN_I_CHOOSE.nova && me === SkillInvocation.ONLY_WHEN_I_CHOOSE.me,
    ...(identity.ok ? { id: identity.id } : { locked: identity.reason }),
    // Only meaningful while our own switch says "on" — when we wrote the deny ourselves, the switch
    // is already telling the whole truth and a second sentence would be noise.
    blockedElsewhere: nova && input.enablement.state === "blocked",
  }
}

/**
 * What moving one or both switches costs on the wire.
 *
 * 🔴 **One `PATCH /config` carries both halves — EXCEPT when a saved row has to be cleared, which
 * this config surface can only express with its second verb.** `PATCH` merges and never deletes
 * (v0.2.0 item 4.3: `null` is a value, not a tombstone), so returning "Show it for me to run" to
 * its default is a `POST /api/config/remove` with an explicit path.
 *
 * ⚠️ Measured against the live route rather than reasoned about: the first version of this function
 * put `{[id]: null}` in the patch and the server answered **400 `Expected object, got null`** while
 * every unit test stayed green.
 *
 * So the request count is: ONE when the skill is being hidden, ONE when it is being shown and
 * nothing was saved, and TWO when a saved row is being cleared. `remove` is emitted only when there
 * is a row to remove, because the removal verb is all-or-nothing and answers 400 for a path that
 * names nothing — asking it to delete an absent row would turn an ordinary click into an error.
 *
 * ⚠️ `permissions` is sent WHOLE and `skill_invocation` as a fragment, and that asymmetry is the
 * store's rather than ours: `config-store-write.ts` folds each settings key with a JSON Merge Patch,
 * which replaces an array wholesale and merges an object key-by-key.
 *
 * Returns `undefined` for a name with no stable id — nothing safe to write, and a mangled key would
 * be a control that flips and does nothing.
 */
export interface InvocationWrite {
  /** The merge patch. Always present: the permission half rides it even when nothing else changes. */
  readonly patch: { permissions: PermissionRule[]; skill_invocation?: Record<string, SkillInvocation.Choice> }
  /** Paths for `POST /api/config/remove`, sent AFTER the patch. Empty when nothing must be cleared. */
  readonly remove: readonly (readonly string[])[]
}

export function invocationWrite(input: {
  readonly name: string
  readonly rules: readonly PermissionRule[]
  readonly store: SkillInvocation.Store | undefined
  readonly next: { readonly nova: boolean; readonly me: boolean }
}): InvocationWrite | undefined {
  const write = SkillInvocation.showWrite(input.name, input.next.me)
  if (write.kind === "unaddressable") return undefined
  const permissions = SkillInvocation.permissionRules(input.rules, input.name, input.next.nova) as PermissionRule[]
  if (write.kind === "set") return { patch: { permissions, skill_invocation: write.patch }, remove: [] }
  const saved = SkillInvocation.entry(input.store, SkillInvocation.idOf(input.name)!) !== undefined
  return { patch: { permissions }, remove: saved ? [write.path] : [] }
}

/** The preset, as the pair it sets. Exported so the page cannot invent a third meaning for it. */
export const ONLY_WHEN_I_CHOOSE = SkillInvocation.ONLY_WHEN_I_CHOOSE

/**
 * Saved choices whose skill is not installed here.
 *
 * The ids come straight from the config store, so they are user/author-authored strings that reach
 * the screen — the page renders them through the same `authorText` every other skill string goes
 * through. Nothing here trims or escapes; that is the renderer's job and it is done in one place.
 */
export function orphanedChoices(store: SkillInvocation.Store | undefined, names: readonly string[]): string[] {
  return SkillInvocation.unresolved(store, names)
}

/** The path that forgets one orphaned choice — the deletion verb, same as clearing a live one. */
export function forgetPath(id: string): readonly string[] {
  return SkillInvocation.clearPath(id)
}
