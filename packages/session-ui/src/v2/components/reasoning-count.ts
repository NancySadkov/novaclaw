import { Token } from "@novaclaw/core/util/token"

/**
 * Compact a token count for the reasoning fold counter ("845" → "1.2k").
 *
 * ⚠️ This was a local k-only copy with no megabyte branch: a 1.2M-token fold rendered "1200.0k" beside
 * the Chats list's "1.2M", and 32,768 rendered "32.8k" here against the list's "33k" — the same number,
 * two ways, on one screen. Shared now; do not re-inline it.
 */
export const compactTokens = Token.compact

/**
 * The reasoning fold's counter, in TOKENS (the unit the Chats list shows — the old label counted raw
 * characters, ~4x the real figure). Uses the provider's REAL reasoning-token count once the step has
 * settled; while the block still streams (no usage yet, or a zero placeholder) it falls back to the
 * shared chars/4 estimate of the streamed text, prefixed "~" so the approximation stays explicit.
 */
export const reasoningTokenLabel = (realTokens: number | undefined, text: string): string =>
  realTokens !== undefined && realTokens > 0 ? compactTokens(realTokens) : `~${compactTokens(Token.estimate(text))}`
