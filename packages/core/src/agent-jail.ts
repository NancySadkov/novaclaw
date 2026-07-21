/**
 * Agent Jail P0 — confine execution, don't classify it (notes/agent-jail-plan.md).
 *
 * A prompt-injected shell command cannot be stopped by matching the command STRING (the
 * GuardFall lesson — see the boundary notes in `util/wildcard.ts` and `permission.ts`). Real
 * containment is a platform sandbox: a restricted filesystem view (the worktree + explicit
 * grants) and deny-by-default egress. This module is the capability seam for that sandbox:
 * the backend PROBE (what confinement this host can actually enforce) and the pure POLICY
 * (what an unattended session's bash is allowed to be — raw, confined, or denied).
 *
 * P0 ships the seam with no backend: `probe()` honestly reports `none` everywhere, and the
 * policy's deny arm only engages for UNATTENDED chains (root type auto-prompting /
 * goal-oriented — no human exists to answer an ask, so any permission success is auto-allow).
 * P1 adds the Linux namespace backend (the Spark, the primary target); macOS/Windows follow.
 */
export * as AgentJail from "./agent-jail"

import type { SessionType } from "./session/config-resolve"

/** The platform sandbox families the probe can report (notes/agent-jail-plan.md §2.2). */
export type BackendKind = "namespaces" | "seatbelt" | "appcontainer" | "none"

export interface BackendInfo {
  readonly kind: BackendKind
  /** The backend can present a restricted filesystem view (worktree + grants only). */
  readonly fs: boolean
  /** The backend can enforce deny-by-default egress with an allowlist. */
  readonly net: boolean
}

export const NO_BACKEND: BackendInfo = { kind: "none", fs: false, net: false }

/**
 * What confinement this host can enforce RIGHT NOW. Honest by construction: no backend is
 * implemented yet, so every platform reports `none` — the policy below then denies unattended
 * raw bash instead of pretending. P1 replaces the Linux arm with a real runtime test
 * (userns/mountns/netns availability — TEST, never assume from the platform string alone).
 */
export function probe(): BackendInfo {
  return NO_BACKEND
}

/**
 * Attendance is a property of the chain ROOT — the question is who answers. Children of an
 * interactive root surface asks to a human (attention pills); under an auto-prompting or
 * goal-oriented root there is no one to ask, so any permission success is auto-allow.
 */
export function attendedRoot(rootType: SessionType): boolean {
  return rootType === "interactive" || rootType === "sub-agent"
}

export type BashDecision = "raw" | "confined" | "deny"

/**
 * The pure bash-confinement policy (plan §2.1/§2.3). Evaluated AFTER permission consent:
 * - an ATTENDED chain runs raw, unchanged (a human saw or approved it — the jail is optional
 *   defense-in-depth later, never a P0 behavior change);
 * - an UNATTENDED chain runs confined when a backend can enforce both boundaries;
 * - an UNATTENDED chain with no (full) backend is denied raw bash — the agent is routed to
 *   the semantic native tools, which are already path-gated. Removing GuardFall's
 *   precondition structurally, not by filtering.
 */
export function decideBash(input: { readonly rootType: SessionType; readonly backend: BackendInfo }): BashDecision {
  if (attendedRoot(input.rootType)) return "raw"
  if (input.backend.fs && input.backend.net) return "confined"
  return "deny"
}

/** The model-legible routing text for a `deny` (1P house style: teach the way forward). */
export function denyMessage(rootType: SessionType): string {
  return (
    `Raw shell execution is not available to ${rootType} sessions on this host: unattended ` +
    `commands require sandbox confinement, and this platform has no sandbox backend yet. ` +
    `Use the native tools instead — read/edit/write/create/glob/grep cover file work and are ` +
    `permission-gated per path. Do not retry the same command.`
  )
}
