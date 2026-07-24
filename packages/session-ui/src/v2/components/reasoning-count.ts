import { Token } from "@novaclaw/core/util/token"

/** Compact a token count for the reasoning fold counter ("845" → "1.2k"). */
export const compactTokens = (tokens: number): string =>
  tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`

/**
 * The reasoning fold's counter, in TOKENS (the unit the Chats list shows — the old label counted raw
 * characters, ~4x the real figure). Uses the provider's REAL reasoning-token count once the step has
 * settled; while the block still streams (no usage yet, or a zero placeholder) it falls back to the
 * shared chars/4 estimate of the streamed text, prefixed "~" so the approximation stays explicit.
 */
export const reasoningTokenLabel = (realTokens: number | undefined, text: string): string =>
  realTokens !== undefined && realTokens > 0 ? compactTokens(realTokens) : `~${compactTokens(Token.estimate(text))}`
