import { imageDimensionsFromData, imageDimensionsFromHeader } from "../../util/token"

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
 * every turn. It decodes a tiny fixed header for ordinary containers and a bounded metadata prefix
 * for JPEG, never the pixel data, so a 12-megapixel photo costs the same here as an icon.
 *
 * `undefined` means *we could not tell* — an unknown container, a truncated header, a URI we do not
 * parse. It is never zero: zero would read as "an image with no pixels", which is a claim, and the
 * whole point of this module is to stop making claims about images we have not looked at.
 */

/**
 * Pixel count from an image's header bytes, or `undefined`.
 *
 * The zero-import parser lives in `util/token.ts`, the lower layer shared by request accounting and
 * footprint reporting. One parser means the two consumers cannot disagree about the same bytes.
 */
export const pixelsFromHeader = (bytes: Uint8Array): number | undefined => {
  const dimensions = imageDimensionsFromHeader(bytes)
  return dimensions === undefined ? undefined : dimensions.width * dimensions.height
}

/**
 * Pixels behind a `data:` image URI, or `undefined` when we cannot tell.
 *
 * ⚠️ The canonical parser's header slice is generous for JPEG on purpose — EXIF and colour-profile
 * segments routinely push the frame header several kilobytes in.
 */
export const pixelsFromDataUri = (uri: string): number | undefined => {
  if (!uri.startsWith("data:")) return undefined
  const dimensions = imageDimensionsFromData(uri)
  return dimensions === undefined ? undefined : dimensions.width * dimensions.height
}
