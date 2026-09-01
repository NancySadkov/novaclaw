export * as Token from "./token"

// Token-count APPROXIMATION — the ONE heuristic shared wherever an exact count isn't in hand yet:
// context packing, compaction, the reasoning budget, the live tokens/s badge, and the reasoning
// fold's streaming counter. Anything already SETTLED must instead read the provider's real reported
// usage (`usage.reasoningTokens`/`tokens.*` → publish-llm-event.ts → the session row); this estimate
// is only for the mid-stream / pre-flight gap where that authoritative number does not exist yet.
//
// Method: segment text by the shapes tokenizers actually see. Prose keeps the familiar ~4 chars/token
// rate; compact structure, paths and high-entropy runs are charged more densely; digit runs are one
// token per character; and non-ASCII uses script/UTF-8-aware rates. This is deliberately a bounded,
// zero-dependency pre-flight estimate. Once a request settles, provider-reported usage anchors the
// next estimate and outranks every heuristic here.
const CHARS_PER_TOKEN = 4
const CJK_CHARS_PER_TOKEN = 1.5
const PATH_CHARS_PER_TOKEN = 2.2
const STRUCTURED_CHARS_PER_TOKEN = 2.4
const HIGH_ENTROPY_CHARS_PER_TOKEN = 1.2
const OTHER_UNICODE_BYTES_PER_TOKEN = 1.5

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

const utf8Bytes = (codePoint: number): number =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

const isAsciiWhitespace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d)
const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39

const distinctAscii = (value: string): number => {
  const seen = new Set<number>()
  for (let index = 0; index < value.length; index++) seen.add(value.charCodeAt(index))
  return seen.size
}

const estimateAsciiRun = (value: string): number => {
  if (!value) return 0
  let digits = 0
  let structured = 0
  let path = false
  let base64Alphabet = true
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (isAsciiDigit(code)) digits++
    if (`{}[],:;()<>\"'=`.includes(value[index]!)) structured++
    if (code === 0x2f || code === 0x5c) path = true
    if (
      !(
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        isAsciiDigit(code) ||
        code === 0x2b ||
        code === 0x2f ||
        code === 0x3d ||
        code === 0x5f ||
        code === 0x2d
      )
    )
      base64Alphabet = false
  }
  if (digits === value.length) return value.length
  if (value.length >= 24 && base64Alphabet && distinctAscii(value) >= 8)
    return value.length / HIGH_ENTROPY_CHARS_PER_TOKEN
  if (path || value.includes("://")) return value.length / PATH_CHARS_PER_TOKEN
  if (structured >= 2 && structured / value.length >= 0.08) return value.length / STRUCTURED_CHARS_PER_TOKEN
  // Digits embedded in an otherwise ordinary span still need their one-token floor.
  return (value.length - digits) / CHARS_PER_TOKEN + digits
}

/** Approximate the token count of TEXT from content shape. Use when the string itself is available. */
export const estimate = (input: string): number => {
  if (!input) return 0
  let total = 0
  let ascii = ""
  const flushAscii = () => {
    total += estimateAsciiRun(ascii)
    ascii = ""
  }
  for (let index = 0; index < input.length; ) {
    const codePoint = input.codePointAt(index)!
    const width = codePoint > 0xffff ? 2 : 1
    if (codePoint <= 0x7f) {
      if (isAsciiWhitespace(codePoint)) {
        flushAscii()
        let spaces = 0
        let newlines = 0
        while (index < input.length) {
          const code = input.charCodeAt(index)
          if (!isAsciiWhitespace(code)) break
          if (code === 0x0a || code === 0x0d) newlines++
          else spaces++
          index++
        }
        // Ordinary single spaces retain chars/4; long indentation compresses much better.
        total += newlines + spaces / (spaces >= 4 ? 8 : CHARS_PER_TOKEN)
        continue
      }
      ascii += input[index]
    } else {
      flushAscii()
      total += isCjk(codePoint) ? 1 / CJK_CHARS_PER_TOKEN : utf8Bytes(codePoint) / OTHER_UNICODE_BYTES_PER_TOKEN
    }
    index += width
  }
  flushAscii()
  return Math.max(0, Math.ceil(total))
}

/**
 * Approximate tokens from a CHARACTER COUNT alone — for streaming meters that accumulate lengths, not
 * the text itself, so content-shape classification cannot apply. This deliberately retains the prose
 * fallback; prefer `estimate` whenever the actual string is available.
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
 * a different server-side preprocessor changes it. It is measured for the floor model, so 32 remains
 * the safe cold-start default; a caller holding an exact-route measurement supplies that divisor to
 * `imageTokens`/`estimateStructured` without importing runtime state into this browser-safe leaf.
 */
/** Safe floor-model patch side. A route profile may supply a measured model/server-specific side. */
export const DEFAULT_IMAGE_PATCH_PIXELS = 32
const IMAGE_MIN_PATCHES = 64
const IMAGE_DELIMITER_TOKENS = 2

const resolveImagePatchPixels = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_IMAGE_PATCH_PIXELS

export const imageTokens = (
  width: number,
  height: number,
  imagePatchPixels: number = DEFAULT_IMAGE_PATCH_PIXELS,
): number => {
  const divisor = resolveImagePatchPixels(imagePatchPixels)
  return (
    IMAGE_DELIMITER_TOKENS + Math.max(IMAGE_MIN_PATCHES, Math.floor(width / divisor) * Math.floor(height / divisor))
  )
}

/** A dimension large enough for ordinary source images while rejecting header-spoofed u32 values. */
const MAX_IMAGE_DIMENSION = 100_000
/** One gigapixel is already far beyond an ordinary model input, but remains finite and representable. */
const MAX_IMAGE_PIXELS = 1_000_000_000
const ORDINARY_HEADER_BYTES = 64
/**
 * JPEG permits 65,535-byte APP segments and commonly puts EXIF plus a split ICC profile before SOF.
 * Four maximum-sized metadata segments fit in this bound; crossing it takes the explicit unknown
 * header fallback instead of decoding an entire photograph on the request path.
 */
const JPEG_HEADER_BYTES = 256 * 1_024

const starts = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((byte, index) => bytes[at + index] === byte)

const saneDimensions = (
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | undefined =>
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= MAX_IMAGE_DIMENSION &&
  height <= MAX_IMAGE_DIMENSION &&
  width * height <= MAX_IMAGE_PIXELS
    ? { width, height }
    : undefined

/**
 * Decode a bounded base64 prefix without importing Node's `Buffer` into this browser-bundled leaf.
 */
const decodeBase64Prefix = (b64: string, bytes: number): Uint8Array | undefined => {
  const chars = Math.ceil(bytes / 3) * 4
  // atob rejects a length that is not a multiple of 4, so a partial prefix stops on a group boundary.
  const cut = Math.min(b64.length, chars) & ~3
  if (cut < 4) return undefined
  try {
    const binary = atob(b64.slice(0, cut))
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return undefined
  }
}

const base64Payload = (data: string): string | undefined => {
  if (!data.startsWith("data:")) return data
  const comma = data.indexOf(",")
  if (comma < 0 || !data.slice(5, comma).toLowerCase().split(";").includes("base64")) return undefined
  return data.slice(comma + 1)
}

/**
 * Image dimensions from a header, or `undefined` when they cannot be read.
 *
 * 🔴 `undefined` is NOT "no image" and must never be read as zero — the caller falls back to
 * `MEDIA_PART_TOKENS`. A format this does not know is priced by the old constant, not by nothing.
 */
export const imageDimensionsFromHeader = (
  b: Uint8Array,
): { readonly width: number; readonly height: number } | undefined => {
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
  const u32le = (i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0

  // PNG: 8-byte signature, then an IHDR chunk whose width/height are at fixed offsets 16 and 20.
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (b.length < 24 || u32(8) !== 13 || !starts(b, [0x49, 0x48, 0x44, 0x52], 12)) return undefined
    return saneDimensions(u32(16), u32(20))
  }

  // GIF: exact version signature, then width/height as LITTLE-endian u16 at offsets 6 and 8.
  if (starts(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    if (b.length < 10) return undefined
    return saneDimensions(b[6]! | (b[7]! << 8), b[8]! | (b[9]! << 8))
  }

  // WebP: "RIFF"...."WEBP", then one of three chunk layouts.
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    if (b.length < 20 || u32le(4) < 12) return undefined
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    const chunkBytes = u32le(16)
    if (chunkBytes > u32le(4) - 12) return undefined
    if (kind === "VP8 " && chunkBytes >= 10 && b.length >= 30 && starts(b, [0x9d, 0x01, 0x2a], 23))
      return saneDimensions((b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff)
    if (kind === "VP8L" && chunkBytes >= 5 && b.length >= 25 && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return saneDimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    if (kind === "VP8X" && chunkBytes === 10 && b.length >= 30)
      return saneDimensions(
        (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1,
        (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1,
      )
    return undefined
  }

  // JPEG: walk the marker chain to a Start-Of-Frame. Dimensions are NOT at a fixed offset - an
  // arbitrary run of APPn/COM segments precedes the frame, so the chain must actually be walked.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i < b.length) {
      if (b[i] !== 0xff) return undefined
      while (i < b.length && b[i] === 0xff) i++
      if (i >= b.length) return undefined
      const marker = b[i++]!
      if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return undefined
      // SOF0..SOF15, excluding DHT (c4), JPGA (c8) and DAC (cc), which are not frame headers.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue
      }
      if (i + 1 >= b.length) return undefined
      const len = u16(i)
      if (len < 2 || i + len > b.length) return undefined
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const components = b[i + 7]
        return components !== undefined && components > 0 && len === 8 + 3 * components
          ? saneDimensions(u16(i + 5), u16(i + 3))
          : undefined
      }
      i += len
    }
    return undefined
  }
  return undefined
}

/** Dimensions behind raw base64 or a base64 data URI, decoding only a bounded header prefix. */
export const imageDimensionsFromData = (
  data: string,
): { readonly width: number; readonly height: number } | undefined => {
  const b64 = base64Payload(data)
  if (b64 === undefined) return undefined
  const ordinary = decodeBase64Prefix(b64, ORDINARY_HEADER_BYTES)
  if (ordinary === undefined) return undefined
  const bytes = starts(ordinary, [0xff, 0xd8]) ? decodeBase64Prefix(b64, JPEG_HEADER_BYTES) : ordinary
  return bytes === undefined ? undefined : imageDimensionsFromHeader(bytes)
}

/**
 * What one media part costs. The LAW when the header can be read, the flat constant when it cannot.
 *
 * ⚠️ Audio, video and PDF have no pixel grid, so they keep the constant. It is wrong for them too,
 * but it is wrong in a way nobody has measured, and inventing a second unmeasured law would be worse.
 */
const mediaTokens = (item: Record<string, unknown>, imagePatchPixels: number): number => {
  const mime = item["mime"] ?? item["mediaType"]
  if (typeof mime === "string" && !mime.startsWith("image/")) return MEDIA_PART_TOKENS
  const data = item["data"] ?? item["uri"]
  if (typeof data !== "string" || data.length === 0) return MEDIA_PART_TOKENS
  const dim = imageDimensionsFromData(data)
  if (dim === undefined) return MEDIA_PART_TOKENS
  return imageTokens(dim.width, dim.height, imagePatchPixels)
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
export const estimateStructured = (value: unknown, imagePatchPixels: number = DEFAULT_IMAGE_PATCH_PIXELS): number => {
  imagePatchPixels = resolveImagePatchPixels(imagePatchPixels)
  let mediaTokenTotal = 0
  let json: string
  try {
    json =
      JSON.stringify(value, (_key, item: unknown) => {
        if (item !== null && typeof item === "object" && isMediaPart(item as Record<string, unknown>)) {
          // Priced from the header BEFORE the payload is dropped - this is the only point where
          // the bytes are still in hand.
          mediaTokenTotal += mediaTokens(item as Record<string, unknown>, imagePatchPixels)
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
    return estimateUnstringifiable(value, imagePatchPixels)
  }
  return estimate(json) + mediaTokenTotal
}

const FALLBACK_MAX_NODES = 100_000
const FALLBACK_SATURATION_TOKENS = Number.MAX_SAFE_INTEGER

/**
 * JSON rejected this value, so walk its unique graph without recursing. Strings and media retain
 * their real charge; cycles are visited once; a hostile graph/getter saturates at a finite value that
 * cannot be mistaken for spare context.
 */
const estimateUnstringifiable = (value: unknown, imagePatchPixels: number): number => {
  const stack: unknown[] = [value]
  const seen = new WeakSet<object>()
  let nodes = 0
  let total = 0
  const add = (tokens: number) => {
    total = Math.min(FALLBACK_SATURATION_TOKENS, total + tokens)
  }

  try {
    while (stack.length > 0) {
      if (++nodes > FALLBACK_MAX_NODES) return FALLBACK_SATURATION_TOKENS
      const item = stack.pop()
      if (typeof item === "string") {
        add(estimate(item) + 1)
        continue
      }
      if (item === null || typeof item !== "object") {
        add(estimate(String(item)) + 1)
        continue
      }
      if (seen.has(item)) {
        add(2)
        continue
      }
      seen.add(item)
      const record = item as Record<string, unknown>
      const media = isMediaPart(record)
      if (media) add(mediaTokens(record, imagePatchPixels))
      for (const [key, child] of Object.entries(record)) {
        add(estimate(key) + 1)
        if (!media || (key !== "data" && key !== "uri")) stack.push(child)
      }
      if (total === FALLBACK_SATURATION_TOKENS) return total
    }
    return Math.max(1, total)
  } catch {
    return FALLBACK_SATURATION_TOKENS
  }
}

/**
 * A token count, compacted for a badge or a counter ("234", "1.5k", "33k", "1.2M").
 *
 * 🔴 **One implementation, because the two it replaces rendered the SAME count differently on the SAME
 * screen.** The Chats list had this version; the reasoning fold carried a k-only copy with no megabyte
 * branch, so a 1.2M-token fold read "1200.0k" beside the list's "1.2M", and a 32,768-token count read
 * "32.8k" in one place and "33k" in the other.
 *
 * The precision rule is three significant figures: a tenth is informative at 1.5k and noise at 33k.
 */
export function compact(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(count >= 1e4 ? 0 : 1)}k`
  return String(count)
}
