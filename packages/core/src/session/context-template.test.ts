import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ContextTemplate } from "./context-template"

/**
 * THE TAIL TABLE IS THE SINGLE SOURCE for what is appended after the transcript.
 *
 * 🗑️ The system-channel and volatility assertions that used to live here are gone with the
 * monolithic prompt (owner, 2026-09-17): there is no ordered block array to freeze or rebuild, and
 * no `SystemAccounting` instrument to derive. What remains, and is still worth pinning, is that the
 * tail's ORDER is the table's and that the module stays pure.
 */

describe("ContextTemplate — the tail table", () => {
  test("every slot name is unique", () => {
    const names = ContextTemplate.SLOTS.map((slot) => slot.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("slot names are kebab-free identifiers, and every slot states its purpose", () => {
    for (const slot of ContextTemplate.SLOTS) {
      expect(slot.name).toMatch(/^[a-z][a-zA-Z0-9]*$/)
      expect(slot.purpose.length).toBeGreaterThan(20)
    }
  })

  test("the tail order is the table's, and it is stable", () => {
    expect([...ContextTemplate.tailSlotNames()]).toEqual([
      "projectGrounding",
      "memoryRecall",
      "todoReminder",
      "toolCatalogueUpdate",
      "maxSteps",
    ])
  })
})

describe("ContextTemplate — the tail builder", () => {
  test("emits the table's order and SKIPS absent slots", () => {
    const items = ContextTemplate.tailMessages({
      maxSteps: "steps",
      projectGrounding: "ground",
      // memoryRecall and todoReminder deliberately absent
    })
    expect(items).toEqual(["ground", "steps"])
  })

  test("order cannot depend on the argument object's key order", () => {
    const a = ContextTemplate.tailMessages({ maxSteps: 5, memoryRecall: 2, todoReminder: 3 })
    const b = ContextTemplate.tailMessages({ todoReminder: 3, memoryRecall: 2, maxSteps: 5 })
    expect(a).toEqual(b)
    expect(a).toEqual([2, 3, 5])
  })

  test("an empty-string item is KEPT here, because the tail's emptiness rule is the caller's", () => {
    expect(ContextTemplate.tailMessages({ todoReminder: "" })).toEqual([""])
  })
})

describe("ContextTemplate — determinism and purity", () => {
  test("the same arguments produce byte-identical output, every time", () => {
    expect(ContextTemplate.describe()).toBe(ContextTemplate.describe())
    expect(ContextTemplate.tailMessages({ maxSteps: 1, memoryRecall: 2 })).toEqual(
      ContextTemplate.tailMessages({ maxSteps: 1, memoryRecall: 2 }),
    )
  })

  test("🔴 PURITY, as a source ratchet: the module reads nothing but its argument", () => {
    const source = readFileSync(new URL("./context-template.ts", import.meta.url), "utf8")
    for (const impure of [
      "Date.now",
      "new Date",
      "Math.random",
      "performance.now",
      "process.env",
      "crypto.randomUUID",
      "randomUUID",
      "setTimeout",
      "await ",
      "fetch(",
      "readFileSync",
    ])
      expect(source.includes(impure), `context-template.ts must not use ${impure}`).toBe(false)
    expect(source).not.toMatch(/^import /m)
  })
})

describe("ContextTemplate — legibility", () => {
  test("`describe()` names every slot", () => {
    const text = ContextTemplate.describe()
    for (const slot of ContextTemplate.SLOTS) expect(text).toContain(slot.name)
    expect(text.split("\n")).toHaveLength(ContextTemplate.SLOTS.length)
  })
})
