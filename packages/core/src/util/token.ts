export * as Token from "./token"

// Token-count APPROXIMATION — the ONE heuristic shared wherever an exact count isn't in hand yet:
// context packing, compaction, the reasoning budget, the live tokens/s badge, and the reasoning
// fold's streaming counter. Anything already SETTLED must instead read the provider's real reported
// usage (`usage.reasoningTokens`/`tokens.*` → publish-llm-event.ts → the session row); this estimate
// is only for the mid-stream / pre-flight gap where that authoritative number does not exist yet.
//
// Method: ~4 characters per token for Latin/general text — the standard BPE-prose ratio, and Qwen's
// byte-level BPE averages 3–4 chars/tok on English. CJK runs far denser (~1.7 chars/tok on Qwen), so
// a flat chars/4 under-counts CJK by ~2.5x. `estimate` splits CJK from the rest and weights each,
// removing the naive rule's largest error for one extra scan. (Code/JSON tokenize a touch denser than
// prose at ~3.2, but the prose ratio is close and errs SAFE — a soft over-budget, never a hard
// overflow, since the real ceiling is always the provider's own count.)
const CHARS_PER_TOKEN = 4
const CJK_CHARS_PER_TOKEN = 1.7

// Char-code ranges (not a regex literal, to stay ASCII-safe in source) for the scripts a byte-level
// BPE spends far more tokens on: CJK symbols/punctuation + Hiragana/Katakana (3000–30FF), CJK Unified
// Ext-A (3400–4DBF), CJK Unified (4E00–9FFF), Hangul syllables (AC00–D7AF), CJK-compat ideographs
// (F900–FAFF), and full/half-width forms (FF00–FFEF).
const isCjk = (code: number): boolean =>
  (code >= 0x3000 && code <= 0x30ff) ||
  (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xff00 && code <= 0xffef)

/** Approximate the token count of TEXT (CJK-aware). Use when the string itself is available. */
export const estimate = (input: string): number => {
  if (!input) return 0
  let cjk = 0
  for (let i = 0; i < input.length; i++) if (isCjk(input.charCodeAt(i))) cjk++
  const latin = input.length - cjk
  return Math.max(0, Math.round(latin / CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN))
}

/**
 * Approximate tokens from a CHARACTER COUNT alone — for streaming meters that accumulate lengths, not
 * the text itself, so the CJK-aware `estimate` can't apply. Kept on the same ratio so every estimate
 * across the app agrees. Prefer `estimate` whenever the actual string is available.
 */
export const estimateFromChars = (chars: number): number => Math.max(0, Math.round(chars / CHARS_PER_TOKEN))

/**
 * The inverse of `estimateFromChars`: how many characters a token allowance is worth. Lets a streaming
 * meter turn a token ceiling into a CHARACTER cut-point, so a cap stays hard even when a provider
 * delivers one enormous delta (the reasoning-budget hard stop). Same ratio, one place.
 */
export const charsFromTokens = (tokens: number): number => Math.max(0, Math.round(tokens * CHARS_PER_TOKEN))
