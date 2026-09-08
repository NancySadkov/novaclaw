export * as AgentDefaults from "./agent-defaults"

import type { ConfigAgent } from "../config/agent"
import { ModelV2 } from "../model"
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
 *  whole session config. `reasoningBudget` belongs here because it describes how this officer thinks,
 *  while the older boolean `thinkingBudget` remains a per-chat switch over the controller. */
export const DECLARABLE = ["permissionMode", "strict", "shortChat", "reground", "reasoningBudget"] as const
export type Declarable = (typeof DECLARABLE)[number]

/** Fold a colleague's standing choices under a base. Absent fields leave the base untouched. */
export const fold = (base: EffectiveConfig, agent: ConfigAgent.Info | undefined): EffectiveConfig => {
  if (agent === undefined) return { ...base }
  const next = { ...base }
  // 🔴 **THE MODEL, folded here and NOT listed in `DECLARABLE`, because it crosses a shape boundary.**
  // Everything in `DECLARABLE` copies across as-is; the model does not. A colleague's config carries
  // `"providerID/modelID"` as a STRING while `EffectiveConfig.model` is a `{ providerID, id }` ref,
  // so the generic loop below would assign a string into a ref-shaped field and `select()` would
  // match nothing. The same boundary broke the clone feature (`agent-clone.ts`).
  //
  // ⚠️ Until 2026-08-22 the model was folded NOWHERE, and the consequence was that "a model belongs
  // to the colleague" — the whole reason the picker moved into the Tune dialog and the composer's
  // per-chat chip was deleted — did not happen. Measured: a colleague configured
  // `ghostprovider/nosuchmodel` ran on the instance default and never touched its own setting. The
  // model resolver reads `session.model` (the session ROW) or the catalog default and has never
  // consulted the agent registry; `startChat` sends only `{agent, title}`; so nothing carried it.
  const declaredModel = (agent as unknown as Record<string, unknown>)["model"]
  if (typeof declaredModel === "string" && declaredModel.trim() !== "") {
    const parsed = ModelV2.parse(declaredModel)
    const variant = (agent as unknown as Record<string, unknown>)["variant"]
    next.model = {
      providerID: parsed.providerID,
      id: parsed.modelID,
      ...(typeof variant === "string" && variant.trim() !== "" ? { variant } : {}),
    } as EffectiveConfig["model"]
  }
  for (const field of DECLARABLE) {
    const value = (agent as unknown as Record<string, unknown>)[field]
    if (value === undefined)
      continue
      // Assigned rather than merged: a colleague's declaration IS the baseline for its chats, and the
      // narrowing rules that matter run later, over the chain (`resolveConfig`) and the ceilings.
    ;(next as unknown as Record<string, unknown>)[field] = value
  }
  return next
}

/**
 * What this colleague actually declared — for a surface that has to say where a value came from.
 *
 * ⚠️ Includes `model`, which is NOT in `DECLARABLE` because it needs its own shape conversion in
 * `fold`. Two lists that must agree and cannot share a loop is a fork waiting to happen, so
 * `agent-defaults.test.ts` asserts this answer matches what `fold` actually changed.
 */
export const declaredBy = (agent: ConfigAgent.Info | undefined): readonly string[] => {
  if (agent === undefined) return []
  const record = agent as unknown as Record<string, unknown>
  const declared: string[] = DECLARABLE.filter((field) => record[field] !== undefined)
  if (typeof record["model"] === "string" && record["model"].trim() !== "") declared.push("model")
  return declared
}

/** The shipped baseline, for callers with no colleague at all. */
export const NONE: EffectiveConfig = EFFECTIVE_CONFIG_DEFAULTS
