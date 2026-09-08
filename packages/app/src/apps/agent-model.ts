import { AgentModelFit } from "@novaclaw/core/agent/model-fit"
import { Model } from "@novaclaw/schema/model"

// WHICH MODEL a colleague thinks with, and whether it is up to the job it was given.
//
// 🔴 **The model belongs to the COLLEAGUE, not to the chat** (owner: the picker moves into the
// agent's configuration). A chat-scoped model was coherent when a chat was the unit; under the
// roster it means the same colleague answers cleverly in one conversation and poorly in the next,
// for reasons the user cannot see. A colleague has one mind.
//
// ⚠️ And because the user picks the model, we can say something no vendor-chosen-model product can:
// that this colleague's mind may be too small for the job it was handed. It WARNS and never refuses
// — a small model doing a big job badly is the user's call to make, and sometimes the right one.

/**
 * The capability ladder, smallest first — `AgentModelFit.LADDER`, not a copy of it.
 *
 * The ORDER cannot come from the schema (`ModelV2.Tier` is a union of strings and says nothing about
 * which is stronger), so it is hand-kept once, in the module that reasons about it. There used to be
 * a second spelling 39 lines below this one and a third in the tier dialog; a tier added to the
 * schema and to only one of them is a floor the user cannot choose, or a warning that fires on the
 * wrong models.
 */
export const TIERS = AgentModelFit.LADDER
export type Tier = (typeof TIERS)[number]

export const isTier = (value: unknown): value is Tier => TIERS.includes(value as Tier)

// How the model is written in config: `providerID/id`. Both directions live in @novaclaw/schema next to
// Model.Ref — this file's copies spelled the key `modelID`, so every call site had to rename `id` to
// `modelID` on the way in and back on the way out, and the runner's identical parser could not be reused.
export const modelRef = Model.formatRef
export const parseModelRef = Model.parseRef

/**
 * Is this colleague's brief bigger than its mind?
 *
 * The signal is deliberately CRUDE and deliberately explained: a long standing brief — pages of
 * rules, exceptions and standing policy — is what small models drop first, and it is the one thing
 * about a role we can measure without asking a model to judge another model. It is a hint, not a
 * verdict: `undefined` means "no opinion", which is the honest answer most of the time.
 *
 * ⚠️ Never fires without a tier. An unknown model is unknown, and inventing a warning from silence
 * would teach the user to ignore the ones that mean something.
 */
/**
 * The tier ladder as the config dialog offers it, weakest first — an ALIAS of `TIERS`, kept as a
 * name because the dialog reads better for it and 39 lines of separation is exactly how the two
 * spellings drifted apart in the first place.
 *
 * ⚠️ **Here rather than in the dialog**, for the reason `agent-option.ts` records: a `.tsx` imports
 * solid's client-only rendering APIs, so `bun test` cannot load it, and a rule about which tier
 * outranks which would only ever be checkable by reading the source.
 */
export const TIER_CHOICES = TIERS

export const briefTooBigForTier = (input: {
  readonly brief: string | undefined
  readonly personality: string | undefined
  readonly tier: Tier | undefined
}): boolean | undefined => {
  if (input.tier === undefined) return undefined
  const written = `${input.brief ?? ""}\n${input.personality ?? ""}`.trim()
  if (written === "") return false
  // ~250 words of standing instruction is where a floor-tier model starts losing the tail of its
  // own brief. Round numbers, honestly labelled: this is a rule of thumb the UI states as one.
  const long = written.length > 1_500
  const veryLong = written.length > 4_000
  if (input.tier === "micro" || input.tier === "tiny") return long
  if (input.tier === "small") return veryLong
  return false
}
