export * as MediaSize from "./media-size"

/**
 * How many PIXELS an inline image carries — read from its header, without decoding it.
 *
 * 🔴 **Why pixels and not bytes** (measured 2026-08-19, `notes/reports/vision-on-disk-2026-08-19.md`,
 * `tests/image-token-cost.py`). Ten sizes were sent to `holo3.1` twice each — once as incompressible
 * noise, once as a flat colour, a 2–3× difference in file size at identical dimensions. **The token
 * count was identical in every pair.** So measuring an image by its base64 length is wrong in KIND,
 * not in magnitude, and no scaling factor rescues it. What the model charges for is the patch grid:
 *
 *     tokens = 2 + max(64, floor(w / 32) × floor(h / 32))        (holo3.1 — exact on all ten sizes)
 *
 * ⚠️ **The 32 is a property of the MODEL, so it is not in this file.** A different patch size or
 * resize policy gives different numbers. What is universal is that the cost scales with pixels, so
 * this module reports the pixels — a fact about the file — and leaves the divisor to whoever knows
 * which model is about to read it. Compiling a divisor in here would be the same mistake as guessing
 * an image cap for a stranger's endpoint.
 *
 * ⚠️ **Header-only, and it must stay that way.** This runs on the request path for every image in
 * every turn. It decodes at most the first few dozen bytes of base64 and never touches the pixel
 * data, so a 12-megapixel photo costs the same here as an icon.
 *
 * `undefined` means *we could not tell* — an unknown container, a truncated header, a URI we do not
 * parse. It is never zero: zero would read as "an image with no pixels", which is a claim, and the
 * whole point of this module is to stop making claims about images we have not looked at.
 */

/** The first `count` bytes behind a `data:…;base64,` URI, or `undefined` if it is not one. */
const headerBytes = (uri: string, count: number): Uint8Array | undefined => {
  const marker = uri.indexOf(";base64,")
  if (marker === -1 || !uri.startsWith("data:")) return undefined
  // 4 base64 chars encode 3 bytes; take enough characters to cover `count`, rounded up to a group.
  const chars = Math.ceil(count / 3) * 4
  const slice = uri.slice(marker + 8, marker + 8 + chars)
  try {
    const binary = Buffer.from(slice, "base64")
    return binary.length === 0 ? undefined : new Uint8Array(binary)
  } catch {
    return undefined
  }
}

const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!
const u32be = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8)
const starts = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  signature.every((byte, index) => bytes[at + index] === byte)

/**
 * Pixel count from an image's header bytes, or `undefined`.
 *
 * JPEG needs more than a fixed prefix because its size lives in a frame header an arbitrary distance
 * in, behind segments of arbitrary length. It is walked, bounded by whatever header slice we were
 * given — a JPEG whose SOF sits beyond that reads as `undefined`, which is the honest answer.
 */
export const pixelsFromHeader = (bytes: Uint8Array): number | undefined => {
  // PNG: 8-byte signature, then an IHDR chunk whose width/height are at 16 and 20.
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (bytes.length < 24) return undefined
    const width = u32be(bytes, 16)
    const height = u32be(bytes, 20)
    return width > 0 && height > 0 ? width * height : undefined
  }
  // GIF: "GIF87a"/"GIF89a", then the logical screen descriptor, little-endian.
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) {
    if (bytes.length < 10) return undefined
    return u16le(bytes, 6) * u16le(bytes, 8) || undefined
  }
  // WebP: "RIFF" ---- "WEBP", then a VP8 / VP8L / VP8X chunk, each with its own layout.
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    if (starts(bytes, [0x56, 0x50, 0x38, 0x58], 12) && bytes.length >= 30) {
      // VP8X stores width-1 / height-1 as 24-bit little-endian.
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      return width * height
    }
    if (starts(bytes, [0x56, 0x50, 0x38, 0x20], 12) && bytes.length >= 30) {
      // Lossy VP8: a 3-byte start code at 23, then 14-bit width/height.
      return (u16le(bytes, 26) & 0x3fff) * (u16le(bytes, 28) & 0x3fff) || undefined
    }
    if (starts(bytes, [0x56, 0x50, 0x38, 0x4c], 12) && bytes.length >= 25) {
      // Lossless VP8L: 14-bit width-1 and height-1 packed across four bytes after the signature.
      const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)
      return ((packed & 0x3fff) + 1) * (((packed >> 14) & 0x3fff) + 1)
    }
    return undefined
  }
  // JPEG: walk the segments to a start-of-frame marker (C0–CF, excluding the non-frame C4/C8/CC).
  if (starts(bytes, [0xff, 0xd8])) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at++
        continue
      }
      const marker = bytes[at + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return u16be(bytes, at + 7) * u16be(bytes, at + 5) || undefined
      const length = u16be(bytes, at + 2)
      if (length < 2) return undefined
      at += 2 + length
    }
    return undefined
  }
  return undefined
}

/**
 * Pixels behind a `data:` image URI, or `undefined` when we cannot tell.
 *
 * ⚠️ The header slice is generous for JPEG on purpose — EXIF and colour-profile segments routinely
 * push the frame header several kilobytes in, and a slice that stops short would silently report
 * `undefined` for the most common photo format on the platform people take photos with.
 */
export const pixelsFromDataUri = (uri: string): number | undefined => {
  const bytes = headerBytes(uri, uri.startsWith("data:image/jpeg") || uri.startsWith("data:image/jpg") ? 65_536 : 64)
  return bytes === undefined ? undefined : pixelsFromHeader(bytes)
}
