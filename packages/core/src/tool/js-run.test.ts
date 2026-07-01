import { describe, expect, test } from "bun:test"
import { runJs, formatValue } from "./js-run"

describe("runJs", () => {
  test("returns the last-expression value (exact arithmetic)", () => {
    const r = runJs("2 + 3 * 4")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("14")
  })

  test("BigInt exact big-integer math", () => {
    const r = runJs("2n ** 64n")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("18446744073709551616n")
  })

  test("Decimal arbitrary precision (pre-imported, configurable per run)", () => {
    const r = runJs("Decimal.set({ precision: 40 }); new Decimal(1).dividedBy(3).toFixed(30)")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("0.333333333333333333333333333333")
  })

  test("Decimal config does not leak between runs (reset to defaults)", () => {
    runJs("Decimal.set({ precision: 40 }); 1")
    const r = runJs("new Decimal(1).dividedBy(3).toString().length")
    expect(r.ok).toBe(true)
    // default precision is 20 significant digits → "0." + 20 threes = length 22, not 40+
    if (r.ok) expect(r.result).toBe("22")
  })

  test("captures console.log, keeps the final value", () => {
    const r = runJs("console.log('hello', 42, [1,2]); 7")
    expect(r.ok).toBe(true)
    expect(r.logs).toEqual(["hello 42 [\n  1,\n  2\n]"])
    if (r.ok) expect(r.result).toBe("7")
  })

  test("Date is available (solves 'what is today')", () => {
    const r = runJs("new Date(0).toISOString()")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("1970-01-01T00:00:00.000Z")
  })

  test("kills a synchronous infinite loop at the timeout (no hang)", () => {
    const r = runJs("while (true) {}", { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.timedOut).toBe(true)
      expect(r.error).toContain("timed out")
    }
  })

  test("a thrown error becomes an explicit message, not a crash", () => {
    const r = runJs("throw new Error('boom')")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.timedOut).toBe(false)
      expect(r.error).toContain("boom")
    }
  })

  test("a syntax error is reported, not thrown", () => {
    const r = runJs("const = = = ")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.timedOut).toBe(false)
  })

  test("sandbox denies host access", () => {
    for (const ref of ["require", "process", "fetch", "Bun", "module", "globalThis.require", "globalThis.process"]) {
      const r = runJs(`typeof ${ref}`)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.result).toBe("undefined")
    }
  })

  test("formatValue handles special types", () => {
    expect(formatValue(undefined)).toBe("undefined")
    expect(formatValue(null)).toBe("null")
    expect(formatValue(10n)).toBe("10n")
    expect(formatValue("hi")).toBe("hi")
    expect(formatValue(true)).toBe("true")
    expect(formatValue([1, 2, 3])).toContain("2")
  })
})
