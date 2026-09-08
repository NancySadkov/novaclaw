export * as SkillInvocation from "./invocation"

// ─── SKILL INVOCATION: two independent audiences, two independent switches ────────────────────────
//
// The brief: *expose **Nova may choose this** and **Show it for me to run** independently,
// plus an **Only when I choose it** preset.* This module is the whole of that decision, kept pure
// (no Effect, no node builtins, no imports at all) so the kernel gate and the browser both run the
// SAME code rather than two spellings of it.
//
// ─── WHY TWO SWITCHES AND NOT A TRI-STATE ─────────────────────────────────────────────────────────
// The two answer different questions about different audiences, and all four combinations are
// things a person actually wants:
//
//   nova=on  me=on    the ordinary case.
//   nova=off me=on    "Only when I choose it" — I keep it; the agent never reaches for it itself.
//   nova=on  me=off   the agent may use it; it does not clutter MY slash list. (A skill the model
//                     picks well and a human never types is the common shape for the big ones.)
//   nova=off me=off   installed, dormant, still readable in the Skills app.
//
// Collapsing them into one tri-state loses the third row. The preset is therefore a WRITE that sets
// both, never a third axis — see {@link ONLY_WHEN_I_CHOOSE} and {@link presetOf}.
//
// ─── WHERE EACH SWITCH ACTUALLY LIVES, AND WHY THEY ARE NOT IN ONE STORE ──────────────────────────
// Each switch is written to the mechanism that ALREADY decides its audience. Inventing a second gate
// beside an existing one is how two gates come to disagree, and a user then has a switch that says
// "off" over a subsystem that says "allowed".
//
//   · **Nova may choose this** → the `skill` PERMISSION action, i.e. a rule in the instance's
//     `permissions` ruleset (`Config.Info.permissions`, folded into every agent by
//     `config/plugin/agent.ts`). OFF is `{action:"skill", resource:<name>, effect:"deny"}`.
//     That one rule does BOTH halves of "may not choose": `SkillV2.available` drops a denied skill
//     from `<available_skills>` so the model never learns it exists (`skill/guidance.ts`), and the
//     `skill` tool's own assert refuses it if the model names it anyway. A horizon-only switch
//     would be the `explore: "deny"` fault `config/permission.ts` records — refusing execution while
//     leaving the thing advertised — inverted.
//
//   · **Show it for me to run** → `Config.Info.skill_invocation.<id>.show`, consulted by
//     `command/list.ts`. That list IS the human's surface: the composer's slash popover renders it
//     and the session command op dispatches from it. Nothing else reads it, so a `false` here
//     removes the skill from YOUR list and changes nothing about what the agent may do.
//
// ⚠️ **They are not symmetric in force, and the UI must say so.** The first is a safety gate; the
// second is your own list. Presenting them as twins would imply that hiding a skill from your menu
// also keeps the agent off it, which is false.
//
// ─── THE THIRD LAYER: THE FOLDER'S OWN `novaclaw.json` ────────────────────────────────────────────
// Both switches also have a PROJECT-scoped half, and neither of them is a new mechanism:
//
//   · **Nova may choose this** — a project's `permissions` section already carries
//     `{action:"skill", resource:<name>, effect:"deny"}`, and `PermissionV2.evaluateNarrowed` folds
//     it in as a constraint that can only ever make a verdict stricter. Nothing was needed here.
//
//   · **Show it for me to run** — `ProjectFile.Info.skills.<id>.show`, read once through
//     `ProjectFileCache` beside the folder's rules, tune, exclusions and policies, and folded by
//     {@link visibility}.
//
// 🔴 **A project may HIDE a skill and may never UN-HIDE one the instance hid**, which is the same
// law as the other two narrowing layers and exists for the same reason: a `novaclaw.json` travels
// inside a repository the user cloned, so it is untrusted input, and a file that could un-hide would
// be a stranger's repo putting a skill back into its owner's own menu. The enforcement is
// `ProjectFile.narrowSkills`, applied at the cache boundary so what reaches this module is a list of
// ids the folder HIDES — a value with no un-hide in it to forget.
//
// ─── THE STABLE ID ────────────────────────────────────────────────────────────────────────────────
// `SkillV2.Info` has no id — `name · description? · slash? · location · content`, nothing else
// (`packages/schema/src/skill.ts`). So an ID has to be derived, and the derivation is the security
// decision:
//
//   ✅ **Chosen: the skill's own name, verbatim, and only when the name is well-formed enough to be
//      written down.** The name is already the engine's identity — `SkillV2.list()` keys its map on
//      `skill.name`, so two skills with one name cannot both exist. An ID that is anything else
//      would be an identity the engine does not honour. It is also the only handle that is portable
//      (a `novaclaw.json` travels in a repository; an absolute `location` does not) and stable
//      across a re-download, a cache move and every edit to the body.
//
//   ❌ `location` — machine-specific, and moving the cache
//      silently changes what provenance we derive from it. A choice keyed on it would evaporate.
//   ❌ a hash of `content` — changes on every edit, i.e. the opposite of stable.
//   ❌ a minted UUID — nothing persists one. The engine has no per-skill store, and a re-download
//      would mint a new one for the same skill.
//   ❌ a CANONICALIZED name (lowercased / punctuation-folded). This is the tempting one and it is
//      the wrong one: folding maps two distinct names onto one ID, so an imported skill named
//      `Writer` would inherit whatever the user had decided about their own `writer`. Folding ADDS
//      a collision surface on top of the engine's; using the name verbatim adds none.
//
// ⚠️ **The collision that remains is the engine's own, inherited rather than doubled.** Two sources
// that both ship `pdf` collapse to one entry, last source wins, and V2 logs no duplicate-name event
// — still open. A saved choice therefore governs whichever `pdf` survived. That
// is a real hazard and it is not one this module can close from the outside — it belongs on the
// wire, where the collision is made.
//
// ⚠️ **A name that cannot be written down is NOT addressable, and we say so instead of guessing.**
// Four kinds of name fail, each for a mechanical reason rather than a taste one — see
// {@link identify}. The controls are then shown disabled with the reason, which is the honest
// answer: silently storing a mangled key would produce a switch that flips and does nothing.
//
// ⛔ Never build the store's key with a plain `obj[id] = …` on an object literal when `id` may be
// `__proto__`: `{__proto__: v}` sets a PROTOTYPE, and reading `store["__proto__"]` off an ordinary
// object returns `Object.prototype` — a truthy value that is not a choice anyone made. Every read
// here goes through `Object.hasOwn` and every write through a COMPUTED key, which creates an own
// property. `invocation.test.ts` pins a skill actually named `__proto__`.

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The bidi/invisible characters that let a name misrepresent itself. Written as escapes on purpose. */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/
/** C0/C1 controls and the two line separators. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/
/** `Wildcard.match` compiles these into `.*` and `.`; there is no escape for a literal one. */
const WILDCARD = /[*?]/

/**
 * The longest name we will write into a settings key or a project file.
 *
 * A bound rather than a truncation: truncating would fold two long names onto one ID, which is
 * exactly the collision this module refuses to add.
 */
export const MAX_ID_LENGTH = 128

export type UnaddressableReason =
  /** Nothing but whitespace — there is no key to write. */
  | "empty"
  /** Longer than {@link MAX_ID_LENGTH}. */
  | "too-long"
  /** Contains a bidi override, a zero-width character, or a control character. */
  | "invisible"
  /**
   * Contains `*` or `?`.
   *
   * ⚠️ Not cosmetic. "Nova may choose this" is a permission rule matched by
   * `core/src/util/wildcard.ts`, which turns `*` into `.*` and `?` into `.` and offers NO escape for
   * a literal one. A deny written for a skill named `pdf*` would also deny `pdfExfil`. Refusing to
   * write an over-broad rule is the only correct answer.
   */
  | "wildcard"
  /**
   * The name is not in Unicode NFC.
   *
   * Two byte sequences that render identically (`é` as one code point, or as `e` + U+0301) would be
   * two different keys, so a user's saved choice would appear to vanish when the source re-encodes.
   * We do not normalize it for them, because the permission rule has to match the RAW name the
   * engine holds — normalizing the key would silently produce a rule that matches nothing.
   */
  | "unnormalized"

export type Identity =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: UnaddressableReason }

/**
 * The stable ID for a skill name, or the reason it has none.
 *
 * `id` is the name VERBATIM when it passes — never a transformation of it — because the same string
 * is used two ways: as the key of a saved choice, and as the `resource` of the `skill` permission
 * rule that the engine matches against `skill.name`. A key that differed from the name would make
 * the second one match nothing while looking correct.
 */
export function identify(name: string): Identity {
  if (typeof name !== "string") return { ok: false, reason: "empty" }
  if (name.trim() === "") return { ok: false, reason: "empty" }
  if (INVISIBLE.test(name) || CONTROL.test(name)) return { ok: false, reason: "invisible" }
  if (WILDCARD.test(name)) return { ok: false, reason: "wildcard" }
  if (name.normalize("NFC") !== name) return { ok: false, reason: "unnormalized" }
  if (name.length > MAX_ID_LENGTH) return { ok: false, reason: "too-long" }
  return { ok: true, id: name }
}

/** Convenience: the ID, or `undefined` when the name cannot be addressed. */
export function idOf(name: string): string | undefined {
  const identity = identify(name)
  return identity.ok ? identity.id : undefined
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The stored half — "Show it for me to run"
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One saved entry. Sparse on purpose: ABSENT MEANS DEFAULT, never `false`.
 *
 * Same sparse-override discipline `resolveSessionConfig` and `ProjectFile.Tune` run on — a store
 * that wrote every skill's default would freeze the install against a later change to what the
 * default IS, and would grow a row for every skill a user merely looked at.
 */
export interface Choice {
  readonly show?: boolean
}

/** `Config.Info.skill_invocation` — saved choices, keyed by {@link identify}'s id. */
export type Store = { readonly [id: string]: Choice | undefined }

/**
 * A skill shows up in the human's own list unless a saved choice says otherwise.
 *
 * ON by default because a skill the user installed is one they wanted; the switch is an override,
 * not a doorway (AGENTS.md principle 12a).
 */
export const SHOW_BY_DEFAULT = true

/** The saved entry for this id, or `undefined`. `hasOwn`-guarded — see the `__proto__` note above. */
export function entry(store: Store | undefined, id: string): Choice | undefined {
  if (!store || !Object.hasOwn(store, id)) return undefined
  const value = store[id]
  return typeof value === "object" && value !== null ? value : undefined
}

/**
 * Which layer decided whether this skill is in the user's slash list.
 *
 * ⚠️ Three answers, not two, and principle 12(d) is why: *a user who cannot tell which layer hid a
 * skill cannot fix it.* "You hid this" is fixed by a switch on this screen; "this folder hides it"
 * is fixed by editing a file in the repository — and offering the switch for the second case would
 * be offering a control that cannot win.
 */
export type ShownBy =
  /** Nobody said anything — {@link SHOW_BY_DEFAULT}. */
  | "default"
  /** The user's own instance-wide choice. */
  | "instance"
  /** The `novaclaw.json` governing the session's folder. Only ever HIDES — see below. */
  | "project"

export interface Visibility {
  /** Whether it appears in the user's own slash list, all layers folded. */
  readonly show: boolean
  /** Which layer produced {@link show}. */
  readonly by: ShownBy
  /** What the instance alone says — the position the switch on the Skills page holds. */
  readonly instance: boolean
  /** Whether the folder's project file hides this skill. Independent of {@link instance}. */
  readonly project: boolean
}

/**
 * The two layers, folded.
 *
 * 🔴 **A project may HIDE, never UN-HIDE, and that law is spelled in the TYPE rather than in this
 * body.** `projectHidden` is a list of ids the folder hides — `ProjectFile.narrowSkills` has already
 * dropped every `show:true` at the `ProjectFileCache` boundary — so there is no direction here in
 * which a folder's file can add a skill back to a menu the user emptied. A `novaclaw.json` travels
 * inside a repository somebody cloned; the same reason `evaluateNarrowed` refuses to let one widen a
 * permission, and `narrowTune` refuses to let one lower a safety rail.
 *
 * ⚠️ The instance layer is reported EVEN WHEN the project overrides it, because the Skills page
 * still has to draw the user's own switch in the position the user left it. Collapsing the two into
 * one boolean would make the switch jump to "off" in a project folder and back on leaving it, i.e.
 * a control that appears to have been changed by a repository.
 *
 * ⚠️ An unaddressable name resolves to the default and to `by:"default"`. A stored key can only ever
 * be an exact id, so a name with no id matches nothing in either layer — which is the point: a
 * project naming `pdf*` cannot glob, it can only ever match a skill literally called `pdf*`, and
 * such a skill has no id.
 */
export function visibility(
  store: Store | undefined,
  projectHidden: readonly string[] | undefined,
  name: string,
): Visibility {
  const id = idOf(name)
  if (id === undefined)
    return { show: SHOW_BY_DEFAULT, by: "default", instance: SHOW_BY_DEFAULT, project: false }
  const saved = entry(store, id)?.show
  const instance = typeof saved === "boolean" ? saved : SHOW_BY_DEFAULT
  const project = projectHidden !== undefined && projectHidden.includes(id)
  // The project is named FIRST when it hides, because that is the layer the user must act on: their
  // own switch is powerless over it, and reporting "you hid this" would send them to the wrong
  // control. When the instance also hid it the folder's statement is redundant, and the honest
  // sentence is still the one that says a control on this screen cannot bring it back.
  if (project) return { show: false, by: "project", instance, project }
  if (typeof saved === "boolean") return { show: instance, by: "instance", instance, project }
  return { show: SHOW_BY_DEFAULT, by: "default", instance, project }
}

/**
 * Whether this skill appears in the user's own slash list, with the folder's project file folded in.
 *
 * `projectHidden` is `ProjectFileCache.Entry.skills`. Passing `undefined` asks the instance question
 * alone, which is what a surface with no folder in hand should do.
 */
export function showsToUser(
  store: Store | undefined,
  projectHidden: readonly string[] | undefined,
  name: string,
): boolean {
  return visibility(store, projectHidden, name).show
}

/** The `Config.Info` key these choices live under — one spelling, shared by the patch and the path. */
export const SECTION = "skill_invocation"

/**
 * How to write one skill's `show` choice.
 *
 * 🔴 **Two verbs, because this config surface deliberately has no tombstone.** `PATCH /config`
 * merges and can never delete: v0.2.0 item 4.3 refused `null`-as-tombstone by name (the argument is
 * at the top of `merge-patch.ts` — the body is decoded through `Config.Info` BEFORE any merge, so a
 * tombstone would have to be a legal value of the slot it deletes), and deletion is
 * `POST /api/config/remove` with an explicit path.
 *
 * ⚠️ Measured, not assumed: a first cut of this file returned `{[id]: null}` and the live route
 * answered **400 `Expected object, got null at ["skill_invocation"]["pdf"]`**. The unit tests were
 * green throughout — they were testing a shape the wire refuses.
 *
 * Returning to the default therefore CLEARS the row rather than writing `{show:true}`. A store that
 * accumulates rows saying "default" can no longer be told apart from one where the user decided,
 * and it is what the orphan list would then fill up with.
 *
 * ⚠️ Computed key, deliberately — see the `__proto__` note at the top of this file.
 */
export type ShowWrite =
  | { readonly kind: "set"; readonly patch: Record<string, Choice> }
  | { readonly kind: "clear"; readonly path: readonly string[] }
  | { readonly kind: "unaddressable" }

export function showWrite(name: string, show: boolean): ShowWrite {
  const id = idOf(name)
  if (id === undefined) return { kind: "unaddressable" }
  return show === SHOW_BY_DEFAULT ? { kind: "clear", path: [SECTION, id] } : { kind: "set", patch: { [id]: { show } } }
}

/** The removal path for one saved choice — the same spelling {@link showWrite} clears with. */
export function clearPath(id: string): readonly string[] {
  return [SECTION, id]
}

/**
 * Saved choices whose skill is not installed here — the "an ID that no longer resolves" case.
 *
 * They are KEPT, not swept: a skill can be uninstalled and reinstalled, a source can be temporarily
 * unreachable, and quietly discarding the user's decision the first time a download fails would be
 * the worst possible moment to forget it. The surface names them so the user can forget them
 * deliberately.
 */
export function unresolved(store: Store | undefined, names: readonly string[]): string[] {
  if (!store) return []
  const present = new Set(names.flatMap((name) => (idOf(name) === undefined ? [] : [name])))
  return Object.keys(store)
    .filter((id) => Object.hasOwn(store, id) && !present.has(id))
    .sort((a, b) => a.localeCompare(b))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The permission half — "Nova may choose this"
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The shape of one permission rule, restated so this module stays import-free. */
export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/**
 * The `permissions` ruleset with this skill's "Nova may choose it" set to `may`.
 *
 * OFF appends `{action:"skill", resource:<name>, effect:"deny"}`. ON removes every rule that names
 * THIS skill exactly — it never appends an `allow`, because an appended allow would also override a
 * broader deny the operator wrote on purpose (`skill: "deny"` for everything, say), turning "let
 * Nova use this one" into "quietly punch a hole in a policy". Removing our own deny restores
 * whatever the rest of the ruleset already said, which is the only change the user asked for.
 *
 * ⚠️ Exact-resource comparison, never wildcard matching. A rule of `{resource:"*"}` is the
 * operator's, not ours, and this must not delete it.
 */
export function permissionRules(rules: readonly Rule[], name: string, may: boolean): Rule[] {
  const id = idOf(name)
  if (id === undefined) return [...rules]
  const kept = rules.filter((rule) => !(rule.action === "skill" && rule.resource === id))
  return may ? kept : [...kept, { action: "skill", resource: id, effect: "deny" }]
}

/** True when this ruleset carries OUR exact-name deny for the skill. */
export function deniedByName(rules: readonly Rule[], name: string): boolean {
  const id = idOf(name)
  if (id === undefined) return false
  return rules.some((rule) => rule.action === "skill" && rule.resource === id && rule.effect === "deny")
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The pair, and the preset over it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The two switches, resolved. Two booleans — never a tri-state. */
export interface Invocation {
  /** The agent may select this skill on its own initiative. */
  readonly nova: boolean
  /** It appears in the user's own slash list. */
  readonly me: boolean
}

/** The **Only when I choose it** preset: Nova-may-choose OFF, show-it-for-me ON. */
export const ONLY_WHEN_I_CHOOSE: Invocation = { nova: false, me: true }

/**
 * A NAME for the current pair, for a one-line "what is in force right now" (principle 12d).
 *
 * ⚠️ It is a read-only label DERIVED from the two booleans. It is never the stored value and never
 * what a control writes: writing goes through the two switches, or through the preset which sets
 * both at once. Deriving it the other way — storing the label and expanding it — is precisely the
 * tri-state that loses `nova=on, me=off`.
 */
export type Preset = "everywhere" | "only-when-i-choose" | "only-nova" | "nowhere"

export function presetOf(state: Invocation): Preset {
  if (state.nova && state.me) return "everywhere"
  if (!state.nova && state.me) return "only-when-i-choose"
  if (state.nova && !state.me) return "only-nova"
  return "nowhere"
}
