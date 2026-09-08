import { SkillInvocation } from "@novaclaw/core/skill/invocation"
import { governedHere } from "@/components/settings-v2/project-permissions"
import type { TranslationKey } from "@/context/language"
import type { ProjectState } from "@/utils/project-api"

/**
 * The FOLDER's half of the two skill-invocation switches, as an editable choice.
 *
 * The gap: *"skill invocation is instance-scoped only. Project persistence needs a
 * `skills` section in `ProjectFile.Info` + `SECTIONS`, folded through `ProjectFileCache` as a
 * NARROWING constraint."* The kernel half landed; until this module existed the only way to author
 * that section was to hand-edit `novaclaw.json`, which is the poke-a-memory-byte shape principle 12
 * exists to refuse.
 *
 * 🔴 **A folder may HIDE a skill and may never UN-HIDE one the instance hid**, and the control this
 * module drives can only ever spell the first. The enforcement is one layer down and runs on every
 * read (`ProjectFile.narrowSkills` at the `ProjectFileCache` boundary), because an attacker's
 * `novaclaw.json` never goes through our writer. What lives HERE is the twin duty
 * `writableSkills`/`writablePermissions`/`writableTune` all state about themselves: our own surface
 * must not offer a control whose sentence our own reader is guaranteed to discard. So "un-hide it in
 * this folder" is not a position of this switch — turning the switch OFF removes the folder's line
 * entirely (absent means INHERIT), and the skill's visibility falls back to the user's own switch.
 *
 * ⚠️ **A save replaces the `skills` section WHOLE** (`POST /api/project` is section-scoped, not
 * key-scoped), so this module rebuilds the section from what `GET /api/project` reports. Two kinds of
 * line do not survive that round trip, and both are stated rather than hidden:
 *   · a `{"show": true}` entry — sent back deliberately, so the server's `writableSkills` refuses it
 *     and names it in `refusedSkills` and the surface can say the line was removed BECAUSE it never
 *     did anything. Silently omitting it would delete it just the same, with nothing on screen.
 *   · an entry declaring nothing at all (`{"pdf": {}}`) — invisible to `GET /api/project` by
 *     construction (it is neither hidden nor refused) and identical in meaning to absence, so it is
 *     dropped without a report. Nothing a reader does changes when it goes.
 */

/**
 * Whether the folder control can be offered at all, and what a save would DO to the filesystem.
 *
 * 🔴 **`shadowed` is the state this type exists for.** `POST /api/project` writes the ROUTED
 * directory's own `novaclaw.json`, never the ancestor a read resolved to — and
 * `ProjectFileResolve.walk` stops at the NEAREST valid file, so creating one in a subfolder takes the
 * ancestor's *entire* declaration out of force: its permission rules, its Tune, and its `exclude`
 * list, which is the one that keeps files out of a model's context. Hiding a skill is not a decision
 * worth spending someone's "Never read" list on, so the control is withheld and says which file
 * governs instead. Settings → Project is the surface whose subject IS the project file.
 */
export type FolderWritability =
  /** No project governs this folder: a save creates `novaclaw.json` here, shadowing nothing. */
  | { readonly kind: "creates" }
  /** This folder's own file governs it: a save edits the file in front of the user. */
  | { readonly kind: "updates"; readonly file: string }
  /** An ANCESTOR's file governs it. Withheld — see above. */
  | { readonly kind: "shadowed"; readonly file: string }
  /** The governing file does not parse. A write would be refused anyway; say the real reason. */
  | { readonly kind: "invalid"; readonly file: string }
  /** The project read has not answered, or failed. We have not been told, so we claim nothing. */
  | { readonly kind: "unknown" }

export function folderWritability(state: ProjectState | undefined, directory: string): FolderWritability {
  if (!state || directory === "") return { kind: "unknown" }
  if (state.kind === "none") return { kind: "creates" }
  if (state.kind === "invalid") return { kind: "invalid", file: state.file }
  return governedHere(state, directory) ? { kind: "updates", file: state.file } : { kind: "shadowed", file: state.file }
}

/**
 * The sentence that says what a save would do, BEFORE the control (principle 12d).
 *
 * ⚠️ Typed as `TranslationKey`, not `string`. A `Record<…, string>` here would force an `as
 * TranslationKey` at the call site, which is exactly the unchecked-key bypass `i18n/key-typing.test.ts`
 * ratchets — and the cast is what would let a renamed key ship as a missing sentence.
 */
export const WRITABILITY_KEY: Readonly<Record<FolderWritability["kind"], TranslationKey>> = {
  creates: "skills.invocation.project.write.creates",
  updates: "skills.invocation.project.write.updates",
  shadowed: "skills.invocation.project.write.shadowed",
  invalid: "skills.invocation.project.write.invalid",
  unknown: "skills.invocation.project.write.unknown",
}

/** Whether the control may be drawn at all. `shadowed`/`invalid`/`unknown` state why instead. */
export const canWriteFolder = (writability: FolderWritability): boolean =>
  writability.kind === "creates" || writability.kind === "updates"

/**
 * What toggling one folder hide costs on the wire.
 *
 * ⚠️ Removing the LAST hidden id CLEARS the section rather than writing `{}`. The two read
 * identically to every consumer (`Entry.skills` is `narrowSkills(info.skills).hidden`), and a
 * `"skills": {}` line left behind is a sentence that says exactly what no line says — the same call
 * `project-permissions.ts` makes for an emptied ruleset. ⚠️ Unless the file still carries a
 * `show:true` line: that one is sent so the server can refuse it BY NAME, and a `clear` would take it
 * out with no receipt.
 *
 * ⚠️ `no-op` rather than a redundant save. A project write invalidates the cached read for this
 * folder and every descendant, so a write that changes nothing still costs every session under it a
 * re-read of the file.
 */
export type FolderSkillWrite =
  | { readonly kind: "set"; readonly skills: Record<string, { readonly show?: boolean }> }
  | { readonly kind: "clear" }
  | { readonly kind: "no-op" }
  /** The name has no stable id, so there is no key to write. The control is not drawn in this case. */
  | { readonly kind: "unaddressable" }

export function folderSkillWrite(input: {
  /** `GET /api/project`'s `skills` — ids this folder hides, already narrowed. */
  readonly hidden: readonly string[]
  /** `GET /api/project`'s `skillsRefused` — ids the file asks to SHOW, which the reader ignores. */
  readonly refused: readonly string[]
  /** The skill's name VERBATIM. Its id is `SkillInvocation.identify`'s and nothing else. */
  readonly name: string
  readonly hide: boolean
}): FolderSkillWrite {
  const id = SkillInvocation.idOf(input.name)
  if (id === undefined) return { kind: "unaddressable" }
  const held = new Set(input.hidden)
  if (input.hide === held.has(id)) return { kind: "no-op" }
  if (input.hide) held.add(id)
  else held.delete(id)

  // Sorted, so two people hiding two different skills produce the same file rather than a diff whose
  // key order records the click order.
  const ids = [...held].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  // ⚠️ A fresh null-prototype object: a `__proto__` key coming off a decoded project file must land
  // as an own property here rather than reassigning a prototype. `JSON.stringify` is identical.
  // The same hazard `ProjectFile.writableSkills` and `skill/invocation.ts` both record.
  const skills = Object.create(null) as Record<string, { show?: boolean }>
  for (const key of ids) skills[key] = { show: false }
  // The file's inert `show:true` lines ride along so the server names them in `refusedSkills`.
  // ⚠️ Never for the id being toggled: the user just asked for the opposite, and re-asserting a line
  // they are overriding would put a refusal in the receipt for something nobody requested.
  for (const key of input.refused) if (key !== id && !Object.hasOwn(skills, key)) skills[key] = { show: true }

  if (Object.keys(skills).length === 0) return { kind: "clear" }
  return { kind: "set", skills }
}
