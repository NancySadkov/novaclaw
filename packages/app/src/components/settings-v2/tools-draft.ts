/**
 * **WHAT THE TOOLS EDITOR IS ABOUT TO WRITE — and the refusals that come first.**
 *
 * 🔴 The rename that deleted somebody else's tool came from a uniqueness test conditioned on the
 * OPERATION rather than on the value: `if (adding && names.includes(name)) refuse`. On an edit the
 * check was simply not run, and the array being written had already dropped every recipe sharing
 * the new name — so renaming `deploy` onto `backup` wrote one `backup` carrying `deploy`'s manual
 * and the real `backup`, up to 8 KB of authored prose, was gone with no confirm and no undo.
 * `adhoc_tools` is an array and `updateConfig` replaces an array wholesale, so the write is the
 * deletion.
 *
 * ⚠️ **The guard is not re-stated here, it is the only way through.** The next array exists ONLY
 * inside `{ ok: true }`, so there is no expression a caller can write that builds it while skipping
 * the collision test. That is the difference between a check a future edit can walk past and one it
 * cannot: the caps and the pattern are checked in the same place for the same reason.
 *
 * The caps mirror `core/src/adhoc-tools.ts` so a refusal happens at edit time rather than at use
 * time — the kernel does NOT enforce uniqueness (its `merge()` is last-wins by name), which is
 * exactly why this is the only place the invariant lives.
 */

export interface Recipe {
  name: string
  description: string
  manual: string
  enabled?: boolean
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/
export const MAX_DESCRIPTION_CHARS = 300
export const MAX_MANUAL_CHARS = 8_192

/** Why a draft cannot be saved. One arm per field, plus the collision. */
export type RecipeRefusal = "name" | "description" | "manual" | "duplicate"

export type RecipeSavePlan =
  | { readonly ok: true; readonly next: readonly Recipe[] }
  | { readonly ok: false; readonly reason: RecipeRefusal }

/**
 * The array to persist for this draft, or the refusal to show instead.
 *
 * @param editing `""` when adding a new recipe; otherwise the stored name of the one being edited.
 */
export function planRecipeSave(input: {
  readonly recipes: readonly Recipe[]
  readonly editing: string
  readonly name: string
  readonly description: string
  readonly manual: string
}): RecipeSavePlan {
  const name = input.name.trim()
  const description = input.description.trim()
  const manual = input.manual.trim()
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: "name" }
  if (!description || description.length > MAX_DESCRIPTION_CHARS) return { ok: false, reason: "description" }
  if (!manual || manual.length > MAX_MANUAL_CHARS) return { ok: false, reason: "manual" }
  // 🔴 The collision test is on the VALUE — "some OTHER recipe already answers to this name" — and
  // is therefore the same test whether the draft is new or renamed. Adding is just the case where
  // `editing` matches nothing.
  if (input.recipes.some((recipe) => recipe.name === name && recipe.name !== input.editing))
    return { ok: false, reason: "duplicate" }
  // A disabled recipe stays disabled across an edit: the switch is a separate decision from the text.
  const kept = input.recipes.find((recipe) => recipe.name === input.editing)
  const others = input.recipes.filter((recipe) => recipe.name !== input.editing)
  return {
    ok: true,
    next: [...others, { name, description, manual, ...(kept?.enabled === false ? { enabled: false } : {}) }],
  }
}
