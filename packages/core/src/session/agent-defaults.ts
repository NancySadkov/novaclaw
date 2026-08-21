export * as AgentDefaults from "./agent-defaults"

import type { ConfigAgent } from "../config/agent"
import { EFFECTIVE_CONFIG_DEFAULTS, type EffectiveConfig } from "./config-resolve"

/**
 * A COLLEAGUE's standing choices as a LAYER beneath the session entity.
 *
 * 🔴 Owner, 2026-08-21: the Chat/Agent posture, Strict and the permission mode are properties of the
 * agent, not of a conversation. A bookkeeper that needs Analyze mode needs it every time you talk to
 * it; re-choosing on every chat is the same defect the folder chip had — a question the user answers
 * again for a decision that never changes.
 *
 * The resulting precedence, lowest first:
 *
 *     EFFECTIVE_CONFIG_DEFAULTS  <  the colleague's config  <  the folder's tune  <  chain  <  row
 *
 * ⚠️ **The colleague sits UNDER the folder, and that ordering is a security decision.** A folder's
 * `novaclaw.json` may RAISE a supervision rail and never lower one (principle 13); if a colleague's
 * config were folded on top, a cloned repository's rail could be widened again by whichever colleague
 * you happened to open it with. The user's standing choice for a role outranks the shipped defaults
 * and loses to a project asking for more supervision — which is the direction that cannot hurt.
 *
 * ⚠️ **Folds into `defaults`, NOT onto the front of the chain**, for the reason `project-defaults.ts`
 * records: `resolveConfig` gives chain index 0 special authority, so a root session may set a
 * `merge: "narrow"` field freely. Prepending a layer would shift the root to index 1 and silently
 * clamp a root session's own permission mode.
 */

/** The fields a colleague may declare. Deliberately small: these are standing WORK choices, not the
 *  whole session config — a colleague does not get to preset somebody's thinking budget. */
export const DECLARABLE = ["permissionMode", "strict", "shortChat"] as const
export type Declarable = (typeof DECLARABLE)[number]

/** Fold a colleague's standing choices under a base. Absent fields leave the base untouched. */
export const fold = (base: EffectiveConfig, agent: ConfigAgent.Info | undefined): EffectiveConfig => {
  if (agent === undefined) return { ...base }
  const next = { ...base }
  for (const field of DECLARABLE) {
    const value = (agent as unknown as Record<string, unknown>)[field]
    if (value === undefined) continue
    // Assigned rather than merged: a colleague's declaration IS the baseline for its chats, and the
    // narrowing rules that matter run later, over the chain (`resolveConfig`) and the ceilings.
    ;(next as unknown as Record<string, unknown>)[field] = value
  }
  return next
}

/** What this colleague actually declared — for a surface that has to say where a value came from. */
export const declaredBy = (agent: ConfigAgent.Info | undefined): readonly Declarable[] =>
  agent === undefined
    ? []
    : DECLARABLE.filter((field) => (agent as unknown as Record<string, unknown>)[field] !== undefined)

/** The shipped baseline, for callers with no colleague at all. */
export const NONE: EffectiveConfig = EFFECTIVE_CONFIG_DEFAULTS
