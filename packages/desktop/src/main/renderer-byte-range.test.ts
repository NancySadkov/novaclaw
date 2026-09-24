import { expect, test } from "bun:test"
import { parseRendererByteRange } from "./renderer-byte-range"

test("serves ordinary, open, and suffix media ranges", () => {
  expect(parseRendererByteRange("bytes=0-100", 1000)).toEqual({ start: 0, end: 100 })
  expect(parseRendererByteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 })
  expect(parseRendererByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 })
  expect(parseRendererByteRange("bytes=-2000", 1000)).toEqual({ start: 0, end: 999 })
})

test("rejects invalid and out-of-bounds ranges", () => {
  for (const range of ["bytes=", "bytes=1000-", "bytes=90-20", "bytes=-0", "bytes=0-1,3-4", "bytes=abc-def"])
    expect(parseRendererByteRange(range, 1000)).toBeUndefined()
})
