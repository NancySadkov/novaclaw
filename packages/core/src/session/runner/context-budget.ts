export * as ContextBudget from "./context-budget"

import type { ConfigContext } from "../../config/context"
import type { SessionType } from "../config-resolve"

export type Category = "system" | "messages" | "retrieval" | "memory" | "tool_output"

export interface Profile {
  readonly system: number
  readonly messages: number
  readonly retrieval: number
  readonly memory: number
  readonly tool_output: number
}

/** First-principles defaults: an attended chat protects conversation; unattended workers reserve
 * more room for the tool evidence they must act on without a human steering every turn. */
export const DEFAULT_PROFILES: Readonly<Record<SessionType, Profile>> = {
  interactive: { system: 25, messages: 40, retrieval: 10, memory: 5, tool_output: 20 },
  "sub-agent": { system: 25, messages: 30, retrieval: 10, memory: 5, tool_output: 30 },
  "auto-prompting": { system: 20, messages: 25, retrieval: 10, memory: 5, tool_output: 40 },
  "goal-oriented": { system: 20, messages: 25, retrieval: 10, memory: 5, tool_output: 40 },
}

export const enabled = (config: ConfigContext.Info | undefined, sessionOverride: boolean | undefined): boolean =>
  sessionOverride ?? config?.enabled ?? true

export const resolve = (config: ConfigContext.Info | undefined, type: SessionType): Profile => {
  const baseline = DEFAULT_PROFILES[type]
  const override = config?.profiles?.[type]
  return {
    system: override?.system ?? baseline.system,
    messages: override?.messages ?? baseline.messages,
    retrieval: override?.retrieval ?? baseline.retrieval,
    memory: override?.memory ?? baseline.memory,
    tool_output: override?.tool_output ?? baseline.tool_output,
  }
}

export const cap = (contextSize: number, share: number): number => Math.max(0, Math.floor(contextSize * (share / 100)))
