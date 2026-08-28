export * as SessionComponentTier from "./component-tier"

import type { SessionComponentRegistry } from "./component-registry"

export const TIERS = ["operational", "consequential", "privileged"] as const
export type Tier = (typeof TIERS)[number]

export const TIER_ACTION = {
  consequential: "session",
  privileged: "session_privileged",
} as const

/** Closed kernel classification; runtime tool kinds fail closed as privileged. */
export const KERNEL_KIND_TIERS: Record<SessionComponentRegistry.KernelKind, Tier> = {
  title: "operational",
  tuning: "operational",
  permission_mode: "consequential",
  working_folder: "consequential",
  missing_working_folder: "operational",
  system_prompt_override: "privileged",
  device: "operational",
  priority: "operational",
  // Which model answers changes the CHARACTER of every later turn, so it is not a routine knob. A
  // repair the self-healing law promises ("ask any still-working model to fix it") has to be able to
  // reach the model entry.
  model: "consequential",
  // Identity is host-owned authority, not another mutable session preference. `agent` is exposed to
  // the model for reading, while the component registry hard-refuses ordinary writes and removals;
  // privileged is the fail-closed classification if a new caller ever reaches the tier first.
  agent: "privileged",
  // Read-only to an agent (`validateWrite` refuses a non-system write), so the write tier is what a
  // SYSTEM write costs. Kept at the same tier as `permission_mode` because it decides the same
  // thing: whether this chain counts as attended.
  session_type: "consequential",
  // Handing the conversation to a human is a stand-down, not an escalation — and the reverse is
  // refused outright by `validateWrite` rather than priced.
  responder: "operational",
  // It decides whether the deterministic step-tree engine drives the turn, and its bounds. Turning
  // it OFF removes per-step verification from an autonomous run, which is a supervision change.
  strict: "consequential",
  goal: "privileged",
  plan: "privileged",
  // It may grant one real-desktop application, so the whole kind takes the higher tier. Values are
  // not classified from model-authored strings after the fact.
  control_binding: "privileged",
  observation: "operational",
}
const KIND_TIERS: Readonly<Record<string, Tier>> = KERNEL_KIND_TIERS

export const tierOf = (kind: string): Tier => KIND_TIERS[kind] ?? "privileged"

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
  system_prompt_override: "privileged",
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
  plan: "privileged",
  control_binding: "operational",
  observation: "operational",
}
const CROSS_READ_TIERS: Readonly<Record<string, Tier>> = CROSS_READ_KIND_TIERS

export const readTierOf = (kind: string, crossSession: boolean): Tier =>
  crossSession ? (CROSS_READ_TIERS[kind] ?? "privileged") : "operational"
