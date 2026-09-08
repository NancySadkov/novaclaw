export * as AgentModelFit from "./model-fit"

import type { ModelV2 } from "../model"

// WHETHER THE MODEL BEHIND A COLLEAGUE IS UP TO ITS JOB (`notes/named-agents.md` — "role/model fit
// warning"; the owner's rule is *"it warns; it never refuses"*).
//
// 🔴 **A role can now outrun its model silently, and this session is why.** A colleague's model is
// part of its job description, and `runner/model.ts` falls back to the instance default when that
// model is unavailable or has been failing — deliberately, so the colleague keeps working. But
// "keeps working" can mean a bookkeeper written for a frontier model quietly thinking with a micro
// one: it does not error, it just gets things wrong in ways that read as the colleague being bad at
// its job. The fallback made the failure survivable and, in doing so, made it invisible.
//
// ⚠️ **It never refuses, and that is not timidity.** A capability floor is the ROLE AUTHOR's estimate,
// not a measurement — the same role runs fine on a smaller model for an easy request, and the user
// may have exactly one model on the machine. Refusing would turn an author's guess into a veto over
// the user's hardware. Saying so leaves the judgement where it belongs.

/**
 * The tier ladder, weakest first. The ORDER is the whole content of this module — `ModelV2.Tier` is a
 * union of strings and nothing in the schema says `small` is beneath `large`.
 */
export const LADDER: readonly ModelV2.Tier[] = ["micro", "tiny", "small", "medium", "large", "frontier"]

const rank = (tier: ModelV2.Tier): number => LADDER.indexOf(tier)

/**
 * Is the bound model beneath the floor this role declared?
 *
 * ⚠️ **An UNKNOWN tier is not a low one.** A model the catalog has no tier for answers `false` here —
 * a local model somebody added by hand carries no tier, and treating "we do not know" as "too weak"
 * would warn on every hand-configured endpoint, which is most of them on a local-first install.
 * `false` when the role declares no floor, for the same reason: silence is not a requirement.
 */
export const below = (input: {
  readonly needs: ModelV2.Tier | undefined
  readonly bound: ModelV2.Tier | undefined
}): boolean => {
  if (input.needs === undefined || input.bound === undefined) return false
  return rank(input.bound) < rank(input.needs)
}

/**
 * What the colleague is told.
 *
 * 🔴 Addressed TO THE COLLEAGUE, not to the user, because the owner's line is *"the agent says so, in
 * its own voice"*. A banner would say it in the product's voice, in a place the model itself cannot
 * see — so the model would go on promising work it cannot do while a warning sat above the
 * conversation. Told this way it can decide what is worth attempting, and say so as itself.
 *
 * ⚠️ Names both tiers and gives an ACTION. "Your model is weak" invites either paralysis or bravado;
 * what a model can act on is: tell the person, work smaller, do not silently attempt the big thing.
 */
export const notice = (input: {
  readonly needs: ModelV2.Tier
  readonly bound: ModelV2.Tier
  readonly model: string
}): string =>
  `${opening(input.model)}, which is a "${input.bound}" model — your role is set up expecting at ` +
  `least "${input.needs}". Nothing is blocked and you should carry on. But say so plainly to the ` +
  `user the first time it matters, work in smaller and more carefully checked steps than you ` +
  `otherwise would, and do not quietly take on something large as though nothing had changed.`

/**
 * Has this colleague already been told about THIS model?
 *
 * 🔴 The transcript is the record — the same rule the colleague loop bound follows. A side table of
 * "warnings shown" is a second place that can disagree with the conversation, and it would have to be
 * cleared by hand when the binding changes. Scanning for the model's own name means re-binding to a
 * different weak model warns again (a different name is not found), re-binding above the floor stops
 * the warning at its source, and a restart changes nothing because the chat is durable.
 */
export const alreadyTold = (input: { readonly transcript: readonly string[]; readonly model: string }): boolean =>
  input.transcript.some((text) => text.includes(opening(input.model)))

/**
 * The notice's first clause, which is also how a past one is FOUND — one function, used to write and
 * to read.
 *
 * ⚠️ **Not a copy of the phrase.** A `MARKER` constant hand-matched against wording written elsewhere
 * is a subset of a thing that changes: reword the notice and `alreadyTold` silently stops matching,
 * so the colleague is warned again every single turn and nothing fails. Deriving both from here makes
 * that unrepresentable, and `model-fit.test.ts` still asserts the round trip in case this is ever
 * split again.
 *
 * It names the MODEL, so the identity of the warning is the binding it is about: re-binding to a
 * different weak model warns again, and re-binding above the floor stops it at the source.
 */
export const opening = (model: string): string => `You are currently thinking with ${model}`
