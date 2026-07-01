import { describe, expect, test } from "bun:test"
import { binaryNote, detectFileType, hexDump } from "./hex"

const bytes = (...v: number[]) => new Uint8Array(v)

describe("detectFileType", () => {
  test("ELF", () => expect(detectFileType(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01))?.format).toBe("ELF"))
  test("PE / DOS (MZ)", () => expect(detectFileType(bytes(0x4d, 0x5a, 0x90, 0x00))?.format).toBe("PE"))
  test("PNG", () =>
    expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.format).toBe("PNG"))
  test("gzip", () => expect(detectFileType(bytes(0x1f, 0x8b, 0x08, 0x00))?.format).toBe("gzip"))
  test("PDF", () => expect(detectFileType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))?.format).toBe("PDF"))
  test("ZIP", () => expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04))?.format).toBe("ZIP"))
  test("SQLite", () =>
    expect(detectFileType(bytes(0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66))?.format).toBe("SQLite"))
  test("unknown -> undefined", () => expect(detectFileType(bytes(0x01, 0x02, 0x03, 0x04))).toBeUndefined())
  test("empty -> undefined", () => expect(detectFileType(bytes())).toBeUndefined())

  test("tar (magic at 0x101)", () => {
    const buf = new Uint8Array(0x101 + 5)
    buf.set([0x75, 0x73, 0x74, 0x61, 0x72], 0x101)
    expect(detectFileType(buf)?.format).toBe("tar")
  })
  test("ISO 9660 (magic deep at 0x8001)", () => {
    const buf = new Uint8Array(0x8001 + 5)
    buf.set([0x43, 0x44, 0x30, 0x30, 0x31], 0x8001)
    expect(detectFileType(buf)?.format).toBe("ISO 9660")
  })
})

describe("hexDump", () => {
  test("full 16-byte row: offset, hex, ascii gutter (non-printable -> .)", () =>
    expect(hexDump(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15))).toBe(
      "00000000  00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f  |................|",
    ))
  test("printable ascii shows through", () =>
    expect(hexDump(new TextEncoder().encode("ABCDEFGHIJKLMNOP"))).toBe(
      "00000000  41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50  |ABCDEFGHIJKLMNOP|",
    ))
  test("partial last row pads the hex so the gutter aligns", () => {
    const line = hexDump(bytes(0x4d, 0x5a, 0x90, 0x00))
    expect(line.startsWith("00000000  4d 5a 90 00 ")).toBe(true)
    expect(line.endsWith("|MZ..|")).toBe(true)
  })
  test("16 bytes per row", () => expect(hexDump(new Uint8Array(20)).split("\n")).toHaveLength(2))
  test("second row offset advances by 0x10", () =>
    expect(hexDump(new Uint8Array(17)).split("\n")[1].startsWith("00000010 ")).toBe(true))
  test("baseOffset pages the window", () =>
    expect(hexDump(bytes(0x41), 0x1000).startsWith("00001000  41 ")).toBe(true))
  test(">4 GB offset is NOT truncated to 32 bits", () =>
    expect(hexDump(bytes(0x00), 0x100000000).startsWith("100000000  00 ")).toBe(true))
  test("empty input -> empty string", () => expect(hexDump(bytes())).toBe(""))
})

describe("binaryNote", () => {
  test("known type: names the format + nudges to hex tools", () => {
    const note = binaryNote("logo.png", 2048, { format: "PNG", description: "PNG image" })
    expect(note).toContain("PNG")
    expect(note).toContain("2048")
    expect(note).toContain("read-hex")
    expect(note).toContain("write-hex")
  })
  test("unknown type reads as unrecognized binary data", () =>
    expect(binaryNote("blob.bin", 10, undefined)).toContain("unrecognized binary data"))
})
