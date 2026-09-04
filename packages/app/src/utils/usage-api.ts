import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

/** Per-model rollup. `output` folds reasoning in, matching what the server sends. */
export interface UsageModel {
  readonly messages: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly cost: number
}

export interface UsageSummary {
  readonly totalSessions: number
  readonly totalMessages: number
  readonly totalCost: number
  readonly totalTokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly toolUsage: Readonly<Record<string, number>>
  readonly modelUsage: Readonly<Record<string, UsageModel>>
  readonly dateRange: { readonly earliest: number; readonly latest: number }
  readonly days: number
  readonly costPerDay: number
  readonly tokensPerSession: number
  readonly medianTokensPerSession: number
}

/**
 * The instance's usage summary.
 *
 * ⚠️ `days` is OMITTED for all-time, never sent as 0 — a window of zero days asks for nothing, and
 * the server distinguishes the two deliberately. Passing `0` here would report an empty instance.
 */
export function fetchUsage(
  server: ServerConnection.HttpBase,
  options: { readonly days?: number } = {},
): Promise<UsageSummary> {
  const query = options.days === undefined ? undefined : { days: String(options.days) }
  return instanceFetch<UsageSummary>(server, { route: "api/usage", query })
}
