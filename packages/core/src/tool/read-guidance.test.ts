import { describe, expect, test } from "bun:test"
import { ReadGuidance } from "./read-guidance"

describe("guidance", () => {
  test("truncated read tells the model to continue from next offset", () => {
    const note = ReadGuidance.guidance({ truncated: true, offset: 1, lines: 2000, bytes: 50_000, next: 2001 })
    expect(note).toContain("offset 2001")
    expect(note).toContain("chunks")
    expect(note).toContain("lines 1-2000")
  })

  test("truncated without explicit next falls back to last+1", () => {
    const note = ReadGuidance.guidance({ truncated: true, offset: 10, lines: 5, bytes: 100 })
    expect(note).toContain("offset 15") // 10 + 5 - 1 = 14 -> resume 15
  })

  test("large whole-file read warns about context, not chunking-by-next", () => {
    const note = ReadGuidance.guidance({ truncated: false, offset: 1, lines: 1600, bytes: 30_000 })
    expect(note).toContain("significant part of your context")
    expect(note).toContain("offset")
  })

  test("large by bytes alone still warns", () => {
    const note = ReadGuidance.guidance({
      truncated: false,
      offset: 1,
      lines: 10,
      bytes: ReadGuidance.LARGE_READ_BYTES,
    })
    expect(note).toBeDefined()
  })

  test("small read produces no warning", () => {
    expect(ReadGuidance.guidance({ truncated: false, offset: 1, lines: 40, bytes: 2_000 })).toBeUndefined()
  })
})

describe("forText", () => {
  test("derives line/byte stats and warns when truncated", () => {
    const note = ReadGuidance.forText({ text: "a\nb\nc", truncated: true, offset: 1, next: 4 })
    expect(note).toContain("offset 4")
  })

  test("no warning for a small whole-file read", () => {
    expect(ReadGuidance.forText({ text: "small file", truncated: false, offset: 1 })).toBeUndefined()
  })

  test("warns for a large whole-file read", () => {
    const note = ReadGuidance.forText({ text: "x\n".repeat(2_000), truncated: false, offset: 1 })
    expect(note).toContain("significant part of your context")
  })
})
