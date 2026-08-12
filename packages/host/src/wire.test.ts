import { describe, expect, test } from "bun:test"
import { decode } from "./wire"

/**
 * The wire format between `host.h` and JavaScript.
 *
 * ⚠️ Tested PURELY, with no library loaded, because this is the one place a silent mistake produces
 * WRONG PATHS rather than an error — an off-by-one here mangles a filename and the caller cannot tell.
 * The library itself is exercised by the smoke run against a real filesystem; this pins the decode.
 */
const encode = (records: ReadonlyArray<{ type: number; path: string }>) => {
  const parts: number[] = []
  const encoder = new TextEncoder()
  for (const record of records) {
    parts.push(record.type)
    for (const byte of encoder.encode(record.path)) parts.push(byte)
    parts.push(0)
  }
  return new Uint8Array(parts)
}

describe("wire decode", () => {
  test("reads the four event types with their paths", () => {
    const buffer = encode([
      { type: 1, path: "/a/create.txt" },
      { type: 2, path: "/a/update.txt" },
      { type: 3, path: "/a/delete.txt" },
      { type: 4, path: "" },
    ])
    expect(decode(buffer, buffer.length)).toEqual([
      { type: "create", path: "/a/create.txt" },
      { type: "update", path: "/a/update.txt" },
      { type: "delete", path: "/a/delete.txt" },
      { type: "overflow", path: "" },
    ])
  })

  test("🔴 decodes only `length` bytes, not the whole buffer", () => {
    // The buffer is REUSED across polls, so bytes past `length` are the previous drain's. Decoding
    // the whole array would replay stale events forever — the defect this argument exists to prevent.
    const buffer = new Uint8Array(256)
    const first = encode([{ type: 1, path: "/only.txt" }])
    buffer.set(first, 0)
    const stale = encode([{ type: 3, path: "/gone.txt" }])
    buffer.set(stale, first.length)
    expect(decode(buffer, first.length)).toEqual([{ type: "create", path: "/only.txt" }])
  })

  test("non-ASCII paths survive the round trip", () => {
    // The C side hands over UTF-8; a byte-wise decode would split a multi-byte character.
    const buffer = encode([{ type: 2, path: "/项目/файл.txt" }])
    expect(decode(buffer, buffer.length)).toEqual([{ type: "update", path: "/项目/файл.txt" }])
  })

  test("an unknown type byte is DROPPED, never guessed into an event", () => {
    // Version skew the ABI check should have caught. Inventing an event from an unknown byte would
    // make a mismatched build fail as wrong behaviour instead of as a refusal.
    const buffer = encode([
      { type: 9, path: "/mystery.txt" },
      { type: 1, path: "/real.txt" },
    ])
    expect(decode(buffer, buffer.length)).toEqual([{ type: "create", path: "/real.txt" }])
  })

  test("an empty drain is an empty list", () => {
    expect(decode(new Uint8Array(64), 0)).toEqual([])
  })
})
