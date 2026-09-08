import { describe, expect, test } from "bun:test"
import { readFailingNames, readSkipCount, readTestCount, stripAnsi } from "./test-output"

describe("test output parsing", () => {
  test("one failed test repeated in Bun's recap remains one ledger identity", () => {
    const output = [
      "test/server/example.test.ts:",
      "(fail) server > returns a typed error [31.4ms]",
      "",
      "1 test failed:",
      "(fail) server > returns a typed error [31.4ms]",
    ].join("\n")

    expect(readFailingNames(output)).toEqual(["server > returns a typed error"])
  })

  test("distinct failures stay distinct, sorted, and timing/ANSI are not identity", () => {
    const esc = String.fromCharCode(27)
    const output = [`${esc}[31m(fail) zeta > second [2.1s]${esc}[0m`, "(fail) alpha > first [4ms]"].join("\n")

    expect(readFailingNames(output)).toEqual(["alpha > first", "zeta > second"])
    expect(stripAnsi(output)).not.toContain(esc)
  })

  test("counts skips only from a complete Bun summary, including ANSI output", () => {
    const ansi = String.fromCharCode(27)
    expect(readSkipCount(`${ansi}[32m 10 pass${ansi}[0m\n 2 skip\n 0 fail`)).toBe(2)
    expect(readSkipCount("10 pass\n1 skip\n3 skip")).toBe(4)
  })

  test("does not turn a crashed or incomplete child into zero skips", () => {
    expect(readSkipCount("error: process exited 2")).toBeUndefined()
    expect(readSkipCount("1 skip\n0 fail")).toBeUndefined()
  })

  test("reads Bun's completed test total and rejects an incomplete summary", () => {
    const ansi = String.fromCharCode(27)
    expect(readTestCount(`${ansi}[2mRan 12 tests across 3 files.\x1b[0m`)).toBe(12)
    expect(readTestCount("12 pass\n12 tests")).toBeUndefined()
  })
})
