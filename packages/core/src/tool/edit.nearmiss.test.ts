import { describe, expect, test } from "bun:test"
import { whitespaceNearMiss } from "./edit"

describe("whitespaceNearMiss (1P/A5)", () => {
  const content = "function a() {\n\tif (x) {\n\t\treturn 1\n\t}\n}\n"

  test("detects a tabs-vs-spaces near miss", () => {
    const search = "function a() {\n  if (x) {\n    return 1\n  }\n}"
    expect(whitespaceNearMiss(content, search)).toBe(true)
  })

  test("detects an indentation-only difference", () => {
    expect(whitespaceNearMiss("    const x = 1\n", "const x = 1")).toBe(true)
  })

  test("detects trailing-space differences", () => {
    expect(whitespaceNearMiss("line one  \nline two\n", "line one\nline two")).toBe(true)
  })

  test("a genuinely absent block is NOT a near miss", () => {
    expect(whitespaceNearMiss(content, "return 2")).toBe(false)
    expect(whitespaceNearMiss(content, "function b() {")).toBe(false)
  })

  test("content differences beyond whitespace are not near misses", () => {
    expect(whitespaceNearMiss("const x = 1", "const x = 2")).toBe(false)
  })

  test("empty search never matches", () => {
    expect(whitespaceNearMiss(content, "")).toBe(false)
    expect(whitespaceNearMiss(content, "  \n\t")).toBe(false)
  })
})
