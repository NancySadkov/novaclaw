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
