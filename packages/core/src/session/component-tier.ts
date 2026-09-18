export * as SessionComponentTier from "./component-tier"

import type { SessionComponentRegistry } from "./component-registry"

/**
 * The session-component tiers, now READ-ONLY.
 *
 * 🔴 **The WRITE tiers are gone (owner, 2026-09-18).** They priced an agent's write of its own
 * components at the `session` / `session_privileged` permission actions, which on a default install
 * resolved to `ask` and then to an immediate refusal. The measured failure was `memo_set` — a
 * colleague's own working memory — answered with *"needs a human's approval… no operator is present
 * to answer a consent prompt"*. Asking was retired as an outcome (`permission.ts`), so a tier was no
 * longer a price: it was a closed door wearing a price tag.
 *
 * The owner's ruling: *"The only things the agent can't change is its personality, goal and project
 * — these are editable only by superior officers."* Those limits are NOT tiers. They are carried by
 * the hard authority gates in `component-registry.ts` (`agent`, `goal`, `session_type`, `responder`,
 * `durable_prompt`, plan verdicts, `working_folder`), which run with a `system` claim and cannot be
 * widened by any permission rule. Everything else a colleague may change itself.
 *
 * ⚠️ **What stays is the CROSS-SESSION read gate, and it is a different question.** Reading one's
 * own state is always free. Reading ANOTHER session's prompt-bearing text (`goal`, `durable`,
 * `durable_prompt`, `plan`) can carry a different user's standing instructions or intent, so it is
 * priced `privileged` — which is a genuine deny-by-default, not a consent card. The tier vocabulary
 * is therefore `operational | privileged`, and the action is only a name.
 */
export const TIERS = ["operational", "privileged"] as const
export type Tier = (typeof TIERS)[number]

export const TIER_ACTION = {
  privileged: "session_privileged",
} as const

/**
 * Reading one's own state is always operational: the session already possesses it. Cross-session
 * reads are broad except for text that can carry another user's standing instructions or intent.
 * Runtime tool kinds fail closed because the kernel cannot know what their value contains.
 */
export const CROSS_READ_KIND_TIERS: Record<SessionComponentRegistry.KernelKind, Tier> = {
  title: "operational",
  tuning: "operational",
  permission_mode: "operational",
  working_folder: "operational",
  missing_working_folder: "operational",
  device: "operational",
  priority: "operational",
  // None of the five carries free text another user could have authored, so reading them across
  // sessions leaks configuration rather than intent — the line this map draws.
  model: "operational",
  agent: "operational",
  session_type: "operational",
  responder: "operational",
  strict: "operational",
  goal: "privileged",
  // 🔴 Cross-session reads of the durable area are PRIVILEGED, and this is the one tier decision here
  // that is about someone else: an item is free text a colleague chose to keep, which is precisely the
  // "text that can carry another user's standing instructions or intent" this map's header draws the
  // line at. Within one's own session the area is already in one's own prompt, so the read costs
  // nothing — `readTierOf` answers `operational` there, and this entry never applies.
  durable: "privileged",
  durable_prompt: "privileged",
  plan: "privileged",
  control_binding: "operational",
  observation: "operational",
}
const CROSS_READ_TIERS: Readonly<Record<string, Tier>> = CROSS_READ_KIND_TIERS

export const readTierOf = (kind: string, crossSession: boolean): Tier =>
  crossSession ? (CROSS_READ_TIERS[kind] ?? "privileged") : "operational"
