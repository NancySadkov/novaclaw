export * as ShortChat from "./short-chat"

import type { Permission } from "@novaclaw/schema/permission"
import { stanceOf } from "../config-resolve"

export const UPGRADE_TOOL = "upgrade_chat"
export const GUIDANCE =
  "This is a short local conversation without project access or memory. Answer ordinary conversation directly. You have one tool: upgrade_chat. If the user asks to upgrade, inspect files, use project tools, or continue as an agent, you MUST call upgrade_chat immediately. Do not answer, offer, or describe the upgrade first; wait for the tool result."

/** The stance, with the descriptor's declared fallback applied. */
export const enabled = (stance: boolean | undefined): boolean => stanceOf("shortChat", stance)

export const systemParts = (input: {
  readonly persona?: string | undefined
  readonly agentIdentity: string
  readonly agentSystem?: string | undefined
}): string[] =>
  [input.persona, input.agentIdentity, input.agentSystem, GUIDANCE].filter(
    (part): part is string => part !== undefined && part.length > 0,
  )

export const offered = (stance: boolean | undefined, toolName: string): boolean =>
  enabled(stance) ? toolName === UPGRADE_TOOL : toolName !== UPGRADE_TOOL

/** Mechanical authority floor. The final exact-name rule keeps Upgrade consent-capable while every
 * other action is hard-denied; permission evaluation is last-match-wins. */
export const permissionRules = (stance: boolean | undefined): Permission.Ruleset =>
  enabled(stance)
    ? [
        { action: "*", resource: "*", effect: "deny" },
        { action: "chat_upgrade", resource: "*", effect: "ask" },
      ]
    : []
