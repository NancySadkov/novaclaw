import { describe, expect, test } from "bun:test"
import { readFailingNames, stripAnsi } from "./test-output"

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
})
