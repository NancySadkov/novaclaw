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
  system_prompt_override: "privileged",
  device: "operational",
  priority: "operational",
  goal: "privileged",
  plan: "privileged",
  control_binding: "consequential",
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
  system_prompt_override: "privileged",
  device: "operational",
  priority: "operational",
  goal: "privileged",
  plan: "privileged",
  control_binding: "operational",
  observation: "operational",
}
const CROSS_READ_TIERS: Readonly<Record<string, Tier>> = CROSS_READ_KIND_TIERS

export const readTierOf = (kind: string, crossSession: boolean): Tier =>
  crossSession ? (CROSS_READ_TIERS[kind] ?? "privileged") : "operational"
