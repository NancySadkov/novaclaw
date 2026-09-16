export * as ModelTaxonomy from "./model-taxonomy"

import { ModelV2 } from "./model"

/**
 * THE ONE PLACE a model's classification is turned into a decision.
 *
 * 🔴 Owner ruling, 2026-09-16: the raw Terminal-Bench percentage is gone. A model is classified
 * `smart` | `usual` | `fast` | `special`, and every choice that used to read a score — which model to
 * route a turn to, whether a colleague's model is beneath its role, how hard to scaffold a weak
 * model, how much memory to inject — reads THIS module instead. That is the whole reason it exists:
 * the old score had three independent ladders (`leastLoaded`'s floor, `AgentModelFit.below`,
 * `scoreBand`'s tier) and only the last one was shared, so the same model could be "large enough to
 * select" and "too small to scaffold for" at once. There is one order here and nothing else may
 * invent another.
 *
 * ## The one distinction that shapes this file: a CLASS, a RANK, and a REQUEST
 *
 * | | what it is | values |
 * |---|---|---|
 * | `Taxonomy` | how a person classified a model | smart, usual, fast, **special (unranked)** |
 * | `Rank` | a model's place in the capability order | smart, usual, fast |
 * | `Requirement` | what a COLLEAGUE asks for | smart, usual, fast |
 *
 * 🔴 **`special` is unranked, and that is the owner's word for it** (2026-09-16: *"Special is not even
 * a rank - it is a way to specify that the model is unranked and used for specific purposes by
 * specific agents"*). So it is not in `Rank` at all: `rankOf` answers `undefined` for it, which is how
 * it drops out of every comparison instead of being given a fake low score and special-cased three
 * times. The first version of this module did exactly that (`rank = -1`, a guard in `satisfies`, a
 * penalty in `fit`) and the owner rejected it — correctly, because a sort that has to know about an
 * unranked thing is a sort that will get it wrong the next time somebody touches it.
 *
 * ⚠️ **`fast` is a capability rank, not a latency promise.** A `smart` model is not `fast` at
 * labeling; the scale is "how much can this model be trusted to work out", and `fast` is the floor of
 * that scale. The words are the user's own and are the only vocabulary a person is asked to learn.
 */

export const Taxonomy = ModelV2.Taxonomy
export type Taxonomy = ModelV2.Taxonomy

/** The capability rank: what can be compared. Never `special`. */
export const Rank = ModelV2.Rank
export type Rank = ModelV2.Rank

/** What a colleague may REQUIRE. Never `special` — see `ModelV2.Requirement`. */
export const Requirement = ModelV2.Requirement
export type Requirement = ModelV2.Requirement

/** What an unclassified model reads as. `usual` is the mainstream job, not the weakest one. */
export const DEFAULT_TAXONOMY = ModelV2.DEFAULT_TAXONOMY

/** Every classification, strongest first — the order a picker offers them in, `special` last. */
export const ALL: readonly Taxonomy[] = ["smart", "usual", "fast", "special"]

/** The ranks, strongest first. */
export const RANKS: readonly Rank[] = ["smart", "usual", "fast"]

/** The ranks a colleague may require, strongest first — `ModelV2.Requirement` as a list. */
export const REQUIREMENTS: readonly Requirement[] = ["smart", "usual", "fast"]

/** Capability order. Higher can do everything a lower one can, and more. */
const ORDER: Readonly<Record<Rank, number>> = { fast: 0, usual: 1, smart: 2 }

/** How far BELOW the wanted rank a model sits counts as "a shortfall", not "slightly worse". */
const SHORTFALL = 10

export const rank = (value: Rank): number => ORDER[value]

/**
 * The classification a model carries.
 *
 * ⚠️ **An unclassified model is `usual`, and that is a deliberate default rather than a missing
 * value.** Owner ruling: *"Usual being default"*. A hand-added local endpoint the user never
 * classified is the mainstream case, so it must be selectable for everyday work and must not be
 * silently demoted to `fast`. (`notes/`'s old warning — "an unknown score is not a low one" —
 * survives here as this function: absence resolves to the middle, and never to `special`.)
 */
export const of = (model: { readonly taxonomy?: Taxonomy | undefined }): Taxonomy => model.taxonomy ?? DEFAULT_TAXONOMY

/**
 * The model's capability RANK, or `undefined` when it is UNRANKED (`special`).
 *
 * 🔴 **This is the whole of "Special is not a rank".** Every comparison below asks this function
 * first, so an unranked model is never placed on the scale at all — it is not a low score, it is
 * absent from the ordering. Anything that must produce a number for an unranked model (`fitOf`) does
 * so explicitly and says why.
 */
export const rankOf = (model: { readonly taxonomy?: Taxonomy | undefined }): Rank | undefined => {
  const classification = of(model)
  return classification === "special" ? undefined : classification
}

/** The human word for a classification, for model-facing prose (system prompts, notices). */
export const label = (taxonomy: Taxonomy): string =>
  taxonomy === "smart" ? "Smart" : taxonomy === "usual" ? "Usual" : taxonomy === "fast" ? "Fast" : "Special"

/**
 * May AUTOMATIC selection put a turn on this model?
 *
 * 🔴 **`false` for an UNRANKED model (`special`), and this is the whole content of the category.**
 * Owner ruling: such a model powers a colleague only when that colleague's settings name THIS model.
 * So every pool the harness chooses from on its own — `leastLoaded`, the unavailable-model
 * substitute, the failing-model substitute, the reconnect probe, the fabricated default, `Agent.
 * generate`'s last resort — filters on this.
 *
 * ⚠️ **A predicate rather than a list, because a new selection call site is the failure mode.** A
 * `filter` copied into five places is a sixth place waiting to forget it; every one of those asks
 * this question instead.
 */
export const autoSelectable = (model: { readonly taxonomy?: Taxonomy | undefined }): boolean =>
  rankOf(model) !== undefined

/** Can a model of this rank serve a request for `want`? Rank is a floor: the rank or above. */
export const satisfies = (have: Rank, want: Requirement): boolean => ORDER[have] >= ORDER[want]

/**
 * How well a model of this rank fits a request for `want` — HIGHER IS BETTER, so a sort can use it
 * directly as a tie-break.
 *
 * 🔴 Exact match wins; then the rank above (over-provisioned but able); then anything below (a real
 * shortfall, kept last so a request always has an answer). The ordering is what makes `leastLoaded`'s
 * load balancing still the primary key: rank only decides between equally idle models.
 */
export const fit = (have: Rank, want: Requirement): number => {
  const distance = ORDER[have] - ORDER[want]
  if (distance === 0) return 0
  if (distance > 0) return -distance
  return -(SHORTFALL + -distance)
}

/**
 * `fit`, read off a model — and the one place an UNRANKED model is given a number.
 *
 * ⚠️ `-Infinity`, and it is not a rank in disguise: it says "this cannot be ordered against the
 * request at all", so a sort puts it last and a caller that reaches here has already made a mistake
 * it can see. `leastLoaded` filters unranked models out before its tie-break, so in production this
 * never returns it; the value exists so the sort stays total rather than throwing.
 */
export const fitOf = (model: { readonly taxonomy?: Taxonomy | undefined }, want: Requirement): number => {
  const have = rankOf(model)
  return have === undefined ? Number.NEGATIVE_INFINITY : fit(have, want)
}

/**
 * The models in `available` that can serve a request for this rank — the general "give me a model for
 * this job", so no caller has to know how ranks compare.
 *
 * ⚠️ **Returns the ADEQUATE pool, not one winner, and may be EMPTY.** Which of several adequate
 * models to use is a scheduling question (device load, locality, the instance default), and an empty
 * pool is a real answer the caller must handle rather than paper over: `leastLoaded` keeps the
 * officer working on whatever can run at all and lets `AgentModelFit` explain the shortfall, exactly
 * as the old score floor did. An unknown request (`undefined`) asks nothing, so every RANKED
 * candidate is adequate.
 *
 * ⚠️ Unranked models are never in the result, which is what makes "the harness does not route to them
 * by itself" a property of this function rather than of its callers.
 */
export const requestModel = (input: {
  readonly taxonomy: Requirement | undefined
  readonly available: readonly ModelV2.Info[]
}): readonly ModelV2.Info[] => {
  const wanted = input.taxonomy
  return input.available.filter((model) => {
    const have = rankOf(model)
    return have !== undefined && (wanted === undefined || satisfies(have, wanted))
  })
}
