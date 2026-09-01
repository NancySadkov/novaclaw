// Pure helpers for session-usage summaries.

import { Token } from "@novaclaw/core/util/token"

export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** input + output + reasoning — the full-traffic figure (details dialog breakdown). */
  total: number
  /**
   * output + reasoning — what the model actually PRODUCED. The Chats-row metric: mixing
   * prompt ingestion into one number is meaningless, and generation is the heavy part.
   */
  generated: number
}

/** Sum token usage across sessions (a chat + its sub-agent threads for the rollup). */
export function tokenTotals(
  sessions: readonly {
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  }[],
): TokenTotals {
  const out = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, generated: 0 }
  for (const session of sessions) {
    const tokens = session.tokens
    if (!tokens) continue
    out.input += tokens.input ?? 0
    out.output += tokens.output ?? 0
    out.reasoning += tokens.reasoning ?? 0
    out.cacheRead += tokens.cache?.read ?? 0
    out.cacheWrite += tokens.cache?.write ?? 0
  }
  out.total = out.input + out.output + out.reasoning
  out.generated = out.output + out.reasoning
  return out
}

/** Compact human token count: 950 · 9.5k · 12k · 1.2M. */
export const compactTokens = Token.compact
