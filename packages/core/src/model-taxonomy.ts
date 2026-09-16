export * as ModelTaxonomy from "./model-taxonomy"

import { ModelV2 } from "./model"

/**
 * THE ONE PLACE model class is turned into a decision.
 *
 * 🔴 Owner ruling, 2026-09-16: the raw Terminal-Bench percentage is gone. A model is rated
 * `smart` | `usual` | `fast`, and every choice that used to read a score — which model to route a
 * turn to, whether a colleague's model is beneath its role, how hard to scaffold a weak model, how
 * much memory to inject — reads THIS module instead. That is the whole reason it exists: the old
 * score had three independent ladders (`leastLoaded`'s floor, `AgentModelFit.below`, `scoreBand`'s
 * tier) and only the last one was shared, so the same model could be "large enough to select" and
 * "too small to scaffold for" at once. There is one rank here and nothing else may invent another.
 *
 * ⚠️ **`fast` is a capability rank, not a latency promise.** A `smart` model is not `fast` at
 * labeling; the scale is "how much can this model be trusted to work out", and `fast` is the floor
 * of that scale, not a speed. The names are the user's own (`smart` is knowledge-heavy work like
 * storywriting; `usual` is coding and administering the OS; `fast` is labeling and searching) and
 * they are the only vocabulary a person is asked to learn.
 */

export const Taxonomy = ModelV2.Taxonomy
export type Taxonomy = ModelV2.Taxonomy

/** The rating an unrated model reads as. `usual` is the mainstream job, not the weakest one. */
export const DEFAULT_TAXONOMY = ModelV2.DEFAULT_TAXONOMY

/** Every class, strongest first — the order a picker offers them in. */
export const ALL: readonly Taxonomy[] = ["smart", "usual", "fast"]

/** Capability rank. Higher can do everything a lower one can, and more. */
const RANK: Readonly<Record<Taxonomy, number>> = { fast: 0, usual: 1, smart: 2 }

/** How far BELOW the `want` class a `have` class sits counts as "a shortfall", not "slightly worse". */
const SHORTFALL = 10

export const rank = (taxonomy: Taxonomy): number => RANK[taxonomy]

/**
 * The class a model is rated as.
 *
 * ⚠️ **An unrated model is `usual`, and that is a deliberate default rather than a missing value.**
 * Owner ruling: *"Usual being default"*. A hand-added local endpoint the user never rated is the
 * mainstream case, so it must be selectable for everyday work and must not be silently demoted to
 * `fast`. (`notes/`'s old warning — "an unknown score is not a low one" — survives here as this
 * function: absence resolves to the middle, never to the floor.)
 */
export const of = (model: { readonly taxonomy?: Taxonomy | undefined }): Taxonomy => model.taxonomy ?? DEFAULT_TAXONOMY

/** The human word for a class, for model-facing prose (system prompts, notices). */
export const label = (taxonomy: Taxonomy): string =>
  taxonomy === "smart" ? "Smart" : taxonomy === "usual" ? "Usual" : "Fast"

/** Can a model rated `have` serve a request for `want`? Capability is a floor: the class or above. */
export const satisfies = (have: Taxonomy, want: Taxonomy): boolean => RANK[have] >= RANK[want]

/**
 * How well a model rated `have` fits a request for `want` — HIGHER IS BETTER, so a sort can use it
 * directly as a tie-break.
 *
 * 🔴 Exact match wins; then the next class above (over-provisioned but able); then anything below
 * (a real shortfall, kept last so a request always has an answer). The ordering is what makes
 * `leastLoaded`'s load balancing still the primary key: class only decides between equally idle
 * models.
 */
export const fit = (have: Taxonomy, want: Taxonomy): number => {
  const distance = RANK[have] - RANK[want]
  if (distance === 0) return 0
  if (distance > 0) return -distance
  return -(SHORTFALL + -distance)
}

/**
 * The models in `available` that can serve a request for this class — the general "give me a model
 * for this job" call, so no caller has to know how classes compare.
 *
 * ⚠️ **Returns the ADEQUATE pool, not one winner, and may be EMPTY.** Which of several adequate
 * models to use is a scheduling question (device load, locality, the instance default), and an
 * empty pool is a real answer the caller must handle rather than paper over: `leastLoaded` keeps the
 * officer working on whatever can run at all and lets `AgentModelFit` explain the shortfall, exactly
 * as the old score floor did. An unknown request (`undefined`) asks nothing, so every candidate is
 * adequate.
 */
export const requestModel = (input: {
  readonly taxonomy: Taxonomy | undefined
  readonly available: readonly ModelV2.Info[]
}): readonly ModelV2.Info[] => {
  const wanted = input.taxonomy
  if (wanted === undefined) return input.available
  return input.available.filter((model) => satisfies(of(model), wanted))
}
