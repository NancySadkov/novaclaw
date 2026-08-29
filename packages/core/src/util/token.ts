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
/**
 * The measured image price, as a LAW rather than a constant.
 *
 * ⭐ Ten image sizes, ten exact matches, no residual (`notes/reports/vision-on-disk-2026-08-19.md`):
 *
 *     tokens = 2 + max(64, floor(w / 32) * floor(h / 32))
 *
 * It reads straight off the architecture — a 32x32-pixel patch grid, a floor of 64 patches, and two
 * delimiter tokens. The 1480x1602 case CONFIRMS rather than merely fits: 46x50 = 2,300 patches,
 * because the odd edges are DROPPED and not padded, and 2,300 + 2 = the measured 2,302 exactly.
 *
 * 🔴 **WHY THIS REPLACES A FLAT CONSTANT.** `MEDIA_PART_TOKENS = 1_500` errs safe for an icon and
 * BREAKS THE MODULE'S CONTRACT for a photograph. Everything up to 256x256 costs 66, so the constant
 * over-counts an icon ~23x; a 12-megapixel photograph costs ~11,627, which the constant UNDER-counts
 * ~7.8x. "A soft over-budget, never a hard overflow" is not satisfied by a number that is 13 % of the
 * true price.
 *
 * ⚠️ **This is a property of the (MODEL x SERVER) pair, not of "images"** — a different patch size or
 * a different server-side preprocessor changes it. It is measured for the floor model. When a second
 * pair is measured, this becomes a per-pair lookup; until then a wrong patch size is still far closer
 * than a constant, because any patch-grid law puts a photograph in the thousands.
 */
const IMAGE_PATCH_PX = 32
const IMAGE_MIN_PATCHES = 64
const IMAGE_DELIMITER_TOKENS = 2

export const imageTokens = (width: number, height: number): number =>
  IMAGE_DELIMITER_TOKENS +
  Math.max(
    IMAGE_MIN_PATCHES,
    Math.floor(width / IMAGE_PATCH_PX) * Math.floor(height / IMAGE_PATCH_PX),
  )

/**
 * Decode just enough of a base64 payload to read an image header.
 *
 * ⚠️ **`atob`, not `Buffer`, ON PURPOSE.** This module is a zero-import leaf that the UI bundles too,
 * and `Buffer` is a Node global that does not exist in a browser. `atob` exists in both.
 * ⚠️ Only a PREFIX is decoded. Every format below carries its dimensions in the first few hundred
 * bytes, and decoding a whole 700 KB screenshot to read four integers is the cost this fix exists to
 * remove.
 */
const HEADER_B64_CHARS = 2_048
const headerBytes = (data: string): Uint8Array | undefined => {
  const comma = data.indexOf(",")
  const b64 = data.slice(0, 5) === "data:" && comma >= 0 ? data.slice(comma + 1) : data
  // atob rejects a length that is not a multiple of 4, so the prefix is cut on a group boundary.
  const cut = Math.min(b64.length, HEADER_B64_CHARS) & ~3
  if (cut < 16) return undefined
  try {
    const binary = atob(b64.slice(0, cut))
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return undefined
  }
}

/**
 * Image dimensions from a header, or `undefined` when they cannot be read.
 *
 * 🔴 `undefined` is NOT "no image" and must never be read as zero — the caller falls back to
 * `MEDIA_PART_TOKENS`. A format this does not know is priced by the old constant, not by nothing.
 */
const dimensionsOf = (b: Uint8Array): { width: number; height: number } | undefined => {
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0

  // PNG: 8-byte signature, then an IHDR chunk whose width/height are at fixed offsets 16 and 20.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { width: u32(16), height: u32(20) }

  // GIF: "GIF8", then width/height as LITTLE-endian u16 at offsets 6 and 8.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) }

  // WebP: "RIFF"...."WEBP", then one of three chunk layouts.
  if (b.length >= 30 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (kind === "VP8 " && b.length >= 30)
      return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff }
    if (kind === "VP8L" && b.length >= 25) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (kind === "VP8X" && b.length >= 30)
      return {
        width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1,
        height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1,
      }
    return undefined
  }

  // JPEG: walk the marker chain to a Start-Of-Frame. Dimensions are NOT at a fixed offset - an
  // arbitrary run of APPn/COM segments precedes the frame, so the chain must actually be walked.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]!
      // SOF0..SOF15, excluding DHT (c4), JPGA (c8) and DAC (cc), which are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: u16(i + 7), height: u16(i + 5) }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = u16(i + 2)
      if (len < 2) return undefined
      i += 2 + len
    }
    return undefined
  }
  return undefined
}

/**
 * What one media part costs. The LAW when the header can be read, the flat constant when it cannot.
 *
 * ⚠️ Audio, video and PDF have no pixel grid, so they keep the constant. It is wrong for them too,
 * but it is wrong in a way nobody has measured, and inventing a second unmeasured law would be worse.
 */
const mediaTokens = (item: Record<string, unknown>): number => {
  const mime = item["mime"] ?? item["mediaType"]
  if (typeof mime === "string" && !mime.startsWith("image/")) return MEDIA_PART_TOKENS
  const data = item["data"] ?? item["uri"]
  if (typeof data !== "string" || data.length === 0) return MEDIA_PART_TOKENS
  const bytes = headerBytes(data)
  if (bytes === undefined) return MEDIA_PART_TOKENS
  const dim = dimensionsOf(bytes)
  if (dim === undefined || !(dim.width > 0) || !(dim.height > 0)) return MEDIA_PART_TOKENS
  return imageTokens(dim.width, dim.height)
}

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
  let mediaTokenTotal = 0
  let json: string
  try {
    json =
      JSON.stringify(value, (_key, item: unknown) => {
        if (item !== null && typeof item === "object" && isMediaPart(item as Record<string, unknown>)) {
          // Priced from the header BEFORE the payload is dropped - this is the only point where
          // the bytes are still in hand.
          mediaTokenTotal += mediaTokens(item as Record<string, unknown>)
          return { ...(item as Record<string, unknown>), data: "", uri: "" }
        }
        return item
      }) ?? ""
  } catch {
    // 🔴 NOT zero. `context-pack`'s `estimateMessage` previously fell back to `estimate(String(value))`
    // here, and zero would tell the packer this message is FREE — the unsafe direction, because it
    // over-packs a window it believes is empty. The two `estimateJson` callers did return 0, so this
    // raises their floor as well; over-estimating is this module's stated contract ("a soft
    // over-budget, never a hard overflow"), and an unstringifiable value is exactly when to take it.
    return estimate(String(value))
  }
  return estimate(json) + mediaTokenTotal
}
