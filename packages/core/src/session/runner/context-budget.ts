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
export type Layout = "officer" | "sub-agent"

export const DEFAULT_PROFILES: Readonly<Record<Layout, Profile>> = {
  officer: { system: 25, messages: 40, retrieval: 10, memory: 5, tool_output: 20 },
  "sub-agent": { system: 25, messages: 30, retrieval: 10, memory: 5, tool_output: 30 },
}

export const enabled = (config: ConfigContext.Info | undefined, sessionOverride: boolean | undefined): boolean =>
  sessionOverride ?? config?.enabled ?? true

export const resolve = (config: ConfigContext.Info | undefined, type: SessionType): Profile => {
  const layout: Layout = type === "sub-agent" ? "sub-agent" : "officer"
  const baseline = DEFAULT_PROFILES[layout]
  const override = config?.profiles?.[layout]
  return {
    system: override?.system ?? baseline.system,
    messages: override?.messages ?? baseline.messages,
    retrieval: override?.retrieval ?? baseline.retrieval,
    memory: override?.memory ?? baseline.memory,
    tool_output: override?.tool_output ?? baseline.tool_output,
  }
}

export const cap = (contextSize: number, share: number): number => Math.max(0, Math.floor(contextSize * (share / 100)))

/** One response allowance for dispatch and compaction. Small windows must retain room for input. */
export const outputTokens = (contextSize: number, requested = 4096): number =>
  Math.max(1, Math.min(Math.floor(contextSize / 4), requested))
