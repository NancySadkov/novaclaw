export * as ShortChat from "./short-chat"

import type { Permission } from "@novaclaw/schema/permission"

export const UPGRADE_TOOL = "upgrade_chat"
export const GUIDANCE =
  "This is a short local conversation. Answer directly without project work or memory. If the user wants Nova to inspect files, use tools, or continue as an agent, offer upgrade_chat and wait for their approval."

export const enabled = (stance: boolean | undefined): boolean => stance === true

export const systemParts = (persona: string | undefined): string[] =>
  [persona, GUIDANCE].filter((part): part is string => part !== undefined && part.length > 0)

export const offered = (stance: boolean | undefined, toolName: string): boolean =>
  !enabled(stance) || toolName === UPGRADE_TOOL

/** Mechanical authority floor. The final exact-name rule keeps Upgrade consent-capable while every
 * other action is hard-denied; permission evaluation is last-match-wins. */
export const permissionRules = (stance: boolean | undefined): Permission.Ruleset =>
  enabled(stance)
    ? [
        { action: "*", resource: "*", effect: "deny" },
        { action: "chat_upgrade", resource: "*", effect: "ask" },
      ]
    : []
