import type { Translator } from "@/context/language"

/**
 * The model classes, strongest first — the ONE literal list the whole UI picks from.
 *
 * ⚠️ A hand-copied literal rather than an import from `@novaclaw/schema`: the app is a thin client
 * that talks to an instance over HTTP, so the wire type (`ConfigV2Model.taxonomy`) is the contract it
 * must match, and importing the server's schema into the client would be a second source of truth
 * that typechecks while the instance it is pointed at may be a different version. The browser test
 * `settings-model-config.test.tsx` fills the picker and asserts the saved value, which is what keeps
 * this list and the instance's closed vocabulary from drifting apart in silence.
 */
export const TAXONOMIES = ["smart", "usual", "fast", "special"] as const
export type Taxonomy = (typeof TAXONOMIES)[number]

/**
 * The classes a COLLEAGUE may require — `ModelV2.Requirement`, and `special` is deliberately absent.
 *
 * 🔴 A model rated `special` is never routed to by the harness (it powers a colleague only when that
 * colleague names the model itself), so "this role requires a Special model" is a contradiction. The
 * server refuses it at the schema, and this shorter list is what keeps the picker from offering a
 * choice the write would reject.
 */
export const REQUIREMENTS = ["smart", "usual", "fast"] as const
export type Requirement = (typeof REQUIREMENTS)[number]

/** `Usual` is the default for an unrated model — see `ModelV2.DEFAULT_TAXONOMY`. */
export const DEFAULT_TAXONOMY: Taxonomy = "usual"

/** Narrow a wire value to the closed vocabulary. Anything else — including absent, which is how an
 *  unrated model arrives — reads as the default, exactly as the instance materialises it. */
export const classify = (value: string | undefined): Taxonomy =>
  value === "smart" || value === "usual" || value === "fast" || value === "special" ? value : DEFAULT_TAXONOMY

/** Narrow a DECLARED requirement. `undefined` for anything outside `REQUIREMENTS`, which includes the
 *  picker's own "no requirement" sentinel — so a caller does not have to know the sentinel's name. */
export const classifyRequirement = (value: string | undefined): Requirement | undefined =>
  value === "smart" || value === "usual" || value === "fast" ? value : undefined

/** The client's copy of the instance's one rank order (`ModelTaxonomy.rank`). Needed locally so the
 *  officer dialog can say "this model is below what you asked for" while both choices are on screen,
 *  with no round trip — the instance still owns the decision that matters.
 *
 *  `special` is BELOW `fast`: it is not a weaker general-purpose model but one for something else, so
 *  it is beneath every requirement a colleague can state. */
const RANK: Readonly<Record<Taxonomy, number>> = { special: -1, fast: 0, usual: 1, smart: 2 }

/** Is a model rated `bound` beneath a role that asks for `needs`? Higher rank is more capable. */
export const isBelow = (bound: Taxonomy, needs: Requirement): boolean => RANK[bound] < RANK[needs]

/** The human word for a class. Shared so the model picker and the colleague's requirement cannot
 *  drift into two vocabularies for the same things. */
export const taxonomyLabel = (t: Translator, value: Taxonomy): string => t(`taxonomy.${value}`)
