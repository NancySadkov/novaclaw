import type { Translator } from "@/context/language"

/**
 * The three model classes, strongest first — the ONE literal list the whole UI picks from.
 *
 * ⚠️ A hand-copied literal rather than an import from `@novaclaw/schema`: the app is a thin client
 * that talks to an instance over HTTP, so the wire type (`ConfigV2Model.taxonomy`) is the contract it
 * must match, and importing the server's schema into the client would be a second source of truth
 * that typechecks while the instance it is pointed at may be a different version. The browser test
 * `settings-model-config.test.tsx` fills the picker and asserts the saved value, which is what keeps
 * this list and the instance's closed vocabulary from drifting apart in silence.
 */
export const TAXONOMIES = ["smart", "usual", "fast"] as const
export type Taxonomy = (typeof TAXONOMIES)[number]

/** `Usual` is the default for an unrated model — see `ModelV2.DEFAULT_TAXONOMY`. */
export const DEFAULT_TAXONOMY: Taxonomy = "usual"

/** Narrow a wire value to the closed vocabulary. Anything else — including absent, which is how an
 *  unrated model arrives — reads as the default, exactly as the instance materialises it. */
export const classify = (value: string | undefined): Taxonomy =>
  value === "smart" || value === "fast" || value === "usual" ? value : DEFAULT_TAXONOMY

/** The client's copy of the instance's one rank order (`ModelTaxonomy.rank`). Needed locally so the
 *  officer dialog can say "this model is below what you asked for" while both choices are on screen,
 *  with no round trip — the instance still owns the decision that matters. */
const RANK: Record<Taxonomy, number> = { fast: 0, usual: 1, smart: 2 }

/** Is a model rated `bound` beneath a role that asks for `needs`? Higher rank is more capable. */
export const isBelow = (bound: Taxonomy, needs: Taxonomy): boolean => RANK[bound] < RANK[needs]

/** The human word for a class. Shared so the model picker and the colleague's requirement cannot
 *  drift into two vocabularies for the same three things. */
export const taxonomyLabel = (t: Translator, value: Taxonomy): string => t(`taxonomy.${value}`)
