import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Token } from "../src/util/token"

// The image price as a LAW, replacing a flat constant that broke this module's own contract.
//
// The law (notes/reports/vision-on-disk-2026-08-19.md, ten sizes, ten exact matches, no residual):
//     tokens = 2 + max(64, floor(w / 32) * floor(h / 32))
//
// 🔴 WHY THE CONSTANT HAD TO GO. `MEDIA_PART_TOKENS = 1_500` errs SAFE for an icon and UNSAFE for a
// photograph: everything to 256x256 costs 66, so the constant over-counted an icon ~23x, while a
// 12-megapixel photograph costs ~11,627 and the constant UNDER-counted it ~7.8x. The module promises
// "a soft over-budget, never a hard overflow", and 13 % of the true price is not that.

describe("the law reproduces its own published measurements", () => {
  // ⭐ THE CONFIRMING CASE, not merely a fitting one: 46x50 = 2,300 patches because the odd edges are
  // DROPPED and not padded, and 2,300 + 2 = the measured 2,302 exactly. A law that padded would give
  // 47x51 + 2 = 2,399 and would pass no test here.
  test("1480x1602 costs exactly the measured 2,302", () => {
    expect(Token.imageTokens(1480, 1602)).toBe(2302)
  })

  test("a 12-megapixel photograph lands where the report says", () => {
    expect(Token.imageTokens(4000, 3000)).toBe(11627)
  })

  // 🔴 THE FLOOR IS THE WHOLE REASON THE OLD ESTIMATOR LOOKED DEFENSIBLE. Every image in an icon
  // corpus sits under it and costs the same 66, which is why file SIZE predicted nothing.
  test("everything up to 256x256 costs 66, whatever its size", () => {
    expect(Token.imageTokens(16, 16)).toBe(66)
    expect(Token.imageTokens(200, 200)).toBe(66)
    expect(Token.imageTokens(256, 256)).toBe(66)
  })

  test("and the very next patch leaves the floor", () => {
    expect(Token.imageTokens(288, 288)).toBe(83)
    expect(Token.imageTokens(288, 288)).toBeGreaterThan(Token.imageTokens(256, 256))
  })

  // ⚠️ MONOTONIC in area. The defect being fixed was non-monotonicity of a different kind - a
  // constant - so the property worth pinning is that a bigger picture never costs less.
  test("a larger image never costs less than a smaller one", () => {
    const sizes = [64, 256, 512, 1024, 2048, 4096]
    for (let i = 1; i < sizes.length; i++)
      expect(Token.imageTokens(sizes[i]!, sizes[i]!)).toBeGreaterThanOrEqual(
        Token.imageTokens(sizes[i - 1]!, sizes[i - 1]!),
      )
  })
})

describe("a route-specific image patch side", () => {
  test("moves at the exact custom patch boundary and retains the 64-patch floor", () => {
    expect(Token.imageTokens(128, 128, 16)).toBe(66)
    expect(Token.imageTokens(255, 255, 16)).toBe(227)
    expect(Token.imageTokens(256, 256, 16)).toBe(258)
    expect(Token.imageTokens(575, 575, 64)).toBe(66)
    expect(Token.imageTokens(576, 576, 64)).toBe(83)
  })

  test("one-pixel patches and very large valid patches remain finite and deterministic", () => {
    expect(Token.imageTokens(100, 100, 1)).toBe(10_002)
    expect(Token.imageTokens(100, 100, Number.MAX_SAFE_INTEGER)).toBe(66)
  })

  test("invalid patch parameters fall back to the safe 32-pixel default", () => {
    const expected = Token.imageTokens(4_000, 3_000)
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(Token.imageTokens(4_000, 3_000, invalid)).toBe(expected)
  })
})

// A media part reaches the estimator in TWO shapes, and pricing only one is how the FIRST version of
// the media fix shipped inert: a user attachment lowers to {type:"media", mediaType, data}, while a
// tool result keeps {type:"file", mime, uri}. Every image in a file-reading workload takes the second.
const media = (mime: string, data: string) => ({ type: "media", mediaType: mime, data })
const file = (mime: string, data: string) => ({ type: "file", mime, uri: data })

/** A real PNG from this repo, 256x256 - the top of the floor, and the measured icon price of 66. */
const GLYPH = path.join(import.meta.dir, "..", "..", "app", "public", "assets", "skin", "glyphs", "calendar.png")
const glyphB64 = () => readFileSync(GLYPH).toString("base64")

describe("estimateStructured prices a REAL image by the law", () => {
  // 🔴 THE WIRING TEST. Every test above passes with `estimateStructured` still multiplying a count
  // by MEDIA_PART_TOKENS - the law would be correct and never called. This is the one that fails if
  // the caller is reverted, and this branch has shipped an uncalled helper twice already.
  test("a 256x256 PNG costs about 66, NOT the 1,500 constant", () => {
    const b64 = glyphB64()
    for (const part of [media("image/png", b64), file("image/png", b64)]) {
      const got = Token.estimateStructured([part])
      // The JSON scaffolding (type, mime, the empty payload keys) costs a few tokens beside the image.
      expect(got).toBeGreaterThanOrEqual(66)
      expect(got).toBeLessThan(120)
      expect(got).toBeLessThan(Token.MEDIA_PART_TOKENS)
    }
  })

  // ⚠️ The base64 of this glyph is ~29,000 characters. Under the ORIGINAL estimator that was ~7,300
  // tokens for a picture worth 66 - the defect this whole line of work began from.
  test("and it does not fall back to counting the base64", () => {
    expect(Token.estimateStructured([media("image/png", glyphB64())])).toBeLessThan(200)
  })

  test("threads a custom patch side through ordinary JSON media pricing", () => {
    const value = [media("image/png", glyphB64())]
    expect(Token.estimateStructured(value, 16) - Token.estimateStructured(value)).toBe(258 - 66)
  })

  test("threads the same custom patch side through the circular fallback walker", () => {
    const value: Record<string, unknown> = {}
    value["self"] = value
    value["part"] = media("image/png", glyphB64())
    expect(Token.estimateStructured(value, 16) - Token.estimateStructured(value)).toBe(258 - 66)
  })

  test("invalid structured-estimator patch parameters use the safe default", () => {
    const value = [media("image/png", glyphB64())]
    const expected = Token.estimateStructured(value)
    for (const invalid of [0, -32, 1.25, Number.NaN, Number.NEGATIVE_INFINITY])
      expect(Token.estimateStructured(value, invalid)).toBe(expected)
  })
})

describe("the header readers", () => {
  // Synthetic headers are the RIGHT fixture here: a parser's input IS the header bytes, so building
  // them exactly is testing the real contract rather than approximating it.
  const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString("base64")
  const pad = (bytes: number[], to: number) => bytes.concat(Array(Math.max(0, to - bytes.length)).fill(0))

  test("PNG dimensions come from the IHDR at fixed offsets", () => {
    // 8-byte signature, 4-byte length, "IHDR", then width and height as big-endian u32.
    const png = pad(
      [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0x00, 0, 0,
        0x03, 0x00,
      ],
      64,
    )
    expect(Token.estimateStructured([media("image/png", b64(png))])).toBeLessThan(Token.imageTokens(1024, 768) + 60)
  })

  test("GIF dimensions are LITTLE-endian, which is the easy one to get backwards", () => {
    // "GIF89a" then width=1024 (0x0400) and height=768 (0x0300) low byte first.
    const gif = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x04, 0x00, 0x03], 32)
    const got = Token.estimateStructured([media("image/gif", b64(gif))])
    expect(got).toBeLessThan(Token.imageTokens(1024, 768) + 60)
    // A big-endian misread would give 4x3 patches, i.e. the floor. Assert we did NOT land there.
    expect(got).toBeGreaterThan(Token.imageTokens(256, 256) + 60)
  })

  test("JPEG reaches SOF beyond ordinary EXIF-sized prefixes", () => {
    const metadata = Array(4_096).fill(0)
    // APP1 length includes its two length bytes. SOF0 describes a real 4000x3000, 3-component frame.
    const jpeg = [
      0xff,
      0xd8,
      0xff,
      0xe1,
      0x10,
      0x02,
      ...metadata,
      0xff,
      0xc0,
      0,
      17,
      8,
      0x0b,
      0xb8,
      0x0f,
      0xa0,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ]
    const got = Token.estimateStructured([media("image/jpeg", b64(jpeg))])
    expect(got).toBeGreaterThanOrEqual(Token.imageTokens(4_000, 3_000))
    expect(got).toBeLessThan(Token.imageTokens(4_000, 3_000) + 60)
  })

  test("partial signatures cannot manufacture dimensions", () => {
    const fakePng = pad([0x89, 0x50, 0x4e, 0x47], 24)
    fakePng.splice(16, 8, 0, 0, 0x04, 0, 0, 0, 0x03, 0)
    const fakeGif = pad([0x47, 0x49, 0x46, 0, 0, 0, 0, 4, 0, 3], 32)
    const fakeWebp = pad([0, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 32)
    const fakeVp8 = pad(
      [0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 10, 0, 0, 0],
      32,
    )
    for (const bytes of [fakePng, fakeGif, fakeWebp, fakeVp8])
      expect(Token.imageDimensionsFromHeader(Uint8Array.from(bytes))).toBeUndefined()
  })

  test("otherwise-valid headers reject absurd dimensions", () => {
    const png = pad(
      [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff, 0xff, 0xff, 0xff, 0,
        0, 0, 1,
      ],
      64,
    )
    expect(Token.imageDimensionsFromHeader(Uint8Array.from(png))).toBeUndefined()
    expect(Token.estimateStructured([media("image/png", b64(png))])).toBeGreaterThanOrEqual(Token.MEDIA_PART_TOKENS)
  })
})

describe("what it does when it CANNOT read the header", () => {
  // 🔴 UNREADABLE IS NOT FREE. A format the parser does not know, or a truncated payload, must fall
  // back to the constant - never to zero. Zero would tell the packer an image is weightless, which is
  // the failure mode this module exists to prevent, in its worst direction.
  test("an unrecognised payload falls back to the constant, not to zero", () => {
    const got = Token.estimateStructured([media("image/png", Buffer.from("not an image at all").toString("base64"))])
    expect(got).toBeGreaterThanOrEqual(Token.MEDIA_PART_TOKENS)
  })

  test("an empty payload falls back to the constant", () => {
    expect(Token.estimateStructured([media("image/png", "")])).toBeGreaterThanOrEqual(Token.MEDIA_PART_TOKENS)
  })

  // ⚠️ Audio, video and PDF have no pixel grid. The constant is wrong for them too, but wrong in a
  // way nobody has measured - and inventing a second unmeasured law would be worse than keeping it.
  test("a non-image media part keeps the constant", () => {
    const pdf = Buffer.from("%PDF-1.7 ...").toString("base64")
    expect(Token.estimateStructured([media("application/pdf", pdf)])).toBeGreaterThanOrEqual(Token.MEDIA_PART_TOKENS)
  })
})
