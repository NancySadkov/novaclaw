import { describe, expect, test } from "bun:test"
import { Bytes } from "./bytes"

describe("Bytes.binary — a measured quantity", () => {
  test("steps GiB -> MiB -> KiB", () => {
    expect(Bytes.binary(3 * Bytes.GIB)).toBe("3.0 GiB")
    expect(Bytes.binary(24 * Bytes.MIB)).toBe("24 MiB")
    expect(Bytes.binary(1.5 * Bytes.MIB)).toBe("1.5 MiB")
    expect(Bytes.binary(700 * Bytes.KIB)).toBe("700 KiB")
  })

  // The precision switch is at 10 MiB exactly, and it is the branch that was rewritten from memory once.
  test("the MiB precision switch is at 10 MiB, not near it", () => {
    expect(Bytes.binary(9.9 * Bytes.MIB)).toBe("9.9 MiB")
    expect(Bytes.binary(10 * Bytes.MIB)).toBe("10 MiB")
  })
})

describe("Bytes.requirement — 'you need at least this much'", () => {
  // 🔴 The unit label is the point. Every memory and disk gate in the tree is written binary
  // (`16 * 1024 ** 3`) while a machine's advertised size is decimal, so a message that divides by 1024³
  // and prints "GB" states a requirement the user appears to meet and is then refused by.
  test("says GiB, because the check it describes is binary", () => {
    expect(Bytes.requirement(8 * Bytes.GIB)).toBe("8.0 GiB")
    expect(Bytes.requirement(16 * Bytes.GIB)).toBe("16 GiB")
    expect(Bytes.requirement(8 * Bytes.GIB)).not.toContain(" GB")
  })

  test("never understates: a tenth over ten rounds UP, not down", () => {
    expect(Bytes.requirement(12.1 * Bytes.GIB)).toBe("13 GiB")
    expect(Bytes.requirement(9.94 * Bytes.GIB)).toBe("9.9 GiB")
  })

  test("a negative or zero reading clamps to 0.0 rather than printing a negative requirement", () => {
    expect(Bytes.requirement(-5 * Bytes.GIB)).toBe("0.0 GiB")
    expect(Bytes.requirement(0)).toBe("0.0 GiB")
  })
})
