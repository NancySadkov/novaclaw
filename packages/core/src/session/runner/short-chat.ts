export * as ShortChat from "./short-chat"

import type { Permission } from "@novaclaw/schema/permission"
import { stanceOf } from "../config-resolve"

/** The stance, with the descriptor's declared fallback applied. */
export const enabled = (stance: boolean | undefined): boolean => stanceOf("shortChat", stance)

/** Pure Chat has no tool horizon. It talks from the user's officer brief and nothing else. */
export const offered = (stance: boolean | undefined, _toolName: string): boolean => !enabled(stance)

/** Mechanical authority floor: a pure Chat can never turn itself into an Agent through a tool call. */
export const permissionRules = (stance: boolean | undefined): Permission.Ruleset =>
  enabled(stance) ? [{ action: "*", resource: "*", effect: "deny" }] : []
