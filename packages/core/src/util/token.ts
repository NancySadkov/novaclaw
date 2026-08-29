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

/**
 * What ONE media part costs, instead of the character length of its base64.
 *
 * 🔴 **Measured 2026-08-29 against a live vision model**, two requests differing only by the image:
 * a 256 px icon costs the provider **66 prompt tokens**, and it is CONSTANT — a 27 KB PNG and a 49 KB
 * PNG both cost 66, because the model resizes to a fixed tile count. Two images cost exactly 132.
 * `JSON.stringify` of one such part is 47,000 characters, which {@link estimate} prices at **11,772**:
 * a 178x over-count, and 250x on a larger file.
 *
 * ⚠️ **The estimator had the wrong SHAPE, not merely the wrong scale.** The provider charges per
 * IMAGE; the character count tracks base64 LENGTH, so the error grew with how badly the PNG
 * compressed — 139x to 250x across four icons from one corpus. Dividing by a constant would not have
 * fixed it.
 *
 * ⚠️ **1,500 rather than the measured 66, deliberately.** 66 is one model's price for a small icon; a
 * large photograph tiles into many more. This module's contract is to err SAFE — *"a soft
 * over-budget, never a hard overflow"* — so it keeps a ~23x margin over the measured icon while
 * removing an error two orders of magnitude larger.
 */
export const MEDIA_PART_TOKENS = 1_500

/**
 * Does this object carry MEDIA BYTES a provider prices per-item rather than per-character?
 *
 * 🔴 **TWO shapes, and missing the second made the first version of this fix INERT for the workload
 * that motivated it.** A user attachment lowers to `{type:"media", mediaType, data}`; a TOOL RESULT
 * keeps `{type:"file", mime, uri}`. Every image in an agentic file-reading workload arrives through
 * the read TOOL, so a rule matching only `media` misses all of them.
 *
 * ⚠️ A `file` part is media only when its MIME says so. A text attachment lowered as `file` is
 * content the model actually reads, and characters ÷ 4 is the right answer for it.
 */
const isMediaPart = (item: Record<string, unknown>): boolean => {
  if (item["type"] === "media") return true
  if (item["type"] !== "file") return false
  const mime = item["mime"] ?? item["mediaType"]
  return (
    typeof mime === "string" &&
    (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf")
  )
}

/**
 * Approximate the token count of a STRUCTURE — the one answer for every caller that would otherwise
 * write `estimate(JSON.stringify(value))`.
 *
 * 🔴 **Three call sites wrote that line independently** — `session/compaction.ts` (when to compact),
 * `session/runner/context-pack.ts` (what fits the window) and `session/compaction-prune.ts` (which
 * tool outputs to ERASE) — and all three inherited the same 178x image error. The pruner's was the
 * worst: weighing an image at 11,772 reclaimable tokens when erasing it frees 66 makes it destroy the
 * pictures, which are the one thing the model cannot reconstruct from text, for nothing.
 *
 * ⚠️ Both payload fields are dropped: a user attachment carries bytes in `data`, a lowered tool
 * result in `uri`. Everything else in the part still counts — the mime and the filename are real
 * prompt content.
 */
export const estimateStructured = (value: unknown): number => {
  let mediaParts = 0
  let json: string
  try {
    json =
      JSON.stringify(value, (_key, item: unknown) => {
        if (item !== null && typeof item === "object" && isMediaPart(item as Record<string, unknown>)) {
          mediaParts++
          return { ...(item as Record<string, unknown>), data: "", uri: "" }
        }
        return item
      }) ?? ""
  } catch {
    return 0
  }
  return estimate(json) + mediaParts * MEDIA_PART_TOKENS
}
