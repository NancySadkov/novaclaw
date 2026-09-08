import { describe, expect, test } from "bun:test"
import { PRESETS, numFromText, optId, optLabel, presetWrite, type RawPreset } from "./preset-value"
import { dict as en } from "@/i18n/en"

/**
 * The shared named-preset control, lifted out of `dialog-model-config.tsx` so the model
 * dialog and the Affective settings tab sell the same parameter the same way.
 *
 * ⚠️ These are the pure halves — the preset table and the three functions the component is built
 * from. They are worth testing directly precisely BECAUSE the component now has two callers: a
 * change made for one of them is a change to both, and nothing else would notice.
 */

/** The app's translator is key-typed; the pure functions take it as a parameter, so a plain lookup
 *  against the real `en` dictionary is the honest stand-in — a stub would let a missing key pass. */
const t = ((key: string) => (en as Record<string, string>)[key] ?? `MISSING:${key}`) as never

describe("numFromText — what 'cleared' looks like coming out of the box", () => {
  test("blank and unparseable are absent", () => {
    for (const raw of ["", "   ", "abc", "1.2.3"]) expect(numFromText(raw)).toBeUndefined()
  })

  // 🔴 The crux. `"0"` used to be indistinguishable from a cleared field, because the
  // Affective tab coerced with `parsed > 0 ? parsed : 0` and the runner read it back through
  // `|| undefined`. A zero that parses to `undefined` here would re-open exactly that.
  test("zero is a VALUE, not an absence", () => {
    expect(numFromText("0")).toBe(0)
    expect(numFromText("0.0")).toBe(0)
  })

  test("ordinary numbers survive, sign included", () => {
    expect(numFromText("0.7")).toBe(0.7)
    expect(numFromText(" 32768 ")).toBe(32768)
    expect(numFromText("-1")).toBe(-1)
  })
})

describe("presetWrite — the Affective tab's clear-vs-set decision", () => {
  test("an empty box CLEARS the key rather than writing a sentinel", () => {
    expect(presetWrite("")).toEqual({ kind: "clear" })
    expect(presetWrite("   ")).toEqual({ kind: "clear" })
  })

  // 🔴 If this ever returns `{kind: "clear"}` again, the tab is back to borrowing a real value to
  // mean "absent", and the reason `precise` was unreachable.
  test("a deliberate 0 is a SET of 0", () => {
    expect(presetWrite("0")).toEqual({ kind: "set", value: 0 })
  })

  test("a normal temperature is a set", () => {
    expect(presetWrite("0.7")).toEqual({ kind: "set", value: 0.7 })
  })
})

describe("the temperature preset list carries both meanings the tab needs", () => {
  // The whole adoption depends on these being two DIFFERENT options. If `{}` were dropped, "Default"
  // would collapse into `precise` and clearing the field would become unexpressible from the list.
  test("an unset option and a real zero are distinct entries", () => {
    const temperature = PRESETS.temperature
    const unset = temperature.filter((p: RawPreset) => p.num === undefined)
    const zero = temperature.filter((p: RawPreset) => p.num === 0)
    expect(unset.length, "the blank 'use the default' preset is gone").toBe(1)
    expect(zero.length, "the real-zero preset is gone").toBe(1)
    expect(zero[0]?.word).toBe("precise")
    expect(optId(unset[0]!)).not.toBe(optId(zero[0]!))
  })

  test("every field has presets, and every preset word resolves to a real label", () => {
    const fields = Object.keys(PRESETS)
    expect(fields.length, "the preset table is empty — this suite would assert nothing").toBeGreaterThan(5)
    for (const field of fields) {
      const list = PRESETS[field as keyof typeof PRESETS]
      expect(list.length, `${field} has no presets`).toBeGreaterThan(0)
      for (const preset of list) {
        const label = optLabel(preset, t)
        expect(label, `${field}: ${JSON.stringify(preset)} rendered a missing i18n key`).not.toContain("MISSING:")
        expect(label.length, `${field}: ${JSON.stringify(preset)} rendered an empty label`).toBeGreaterThan(0)
      }
    }
  })
})

describe("optId — the measured listbox bug stays fixed", () => {
  // A negative value produced the id "-1" and the listbox then refused to open AT ALL: measured with
  // the temperature select opening from identical events while the budget one stayed shut. The
  // comment recording it moved with the code; this is the part that fails if someone "simplifies" it.
  test("no id starts with a hyphen, for any preset in the table", () => {
    for (const list of Object.values(PRESETS))
      for (const preset of list) expect(optId(preset).startsWith("-"), `${JSON.stringify(preset)}`).toBe(false)
  })

  test("the negative case is actually present in the table, so the rule is exercised", () => {
    const negatives = Object.values(PRESETS)
      .flat()
      .filter((p: RawPreset) => (p.num ?? 0) < 0)
    expect(negatives.length, "no negative preset remains — this guard now proves nothing").toBeGreaterThan(0)
    for (const preset of negatives) expect(optId(preset)).toBe(`v${preset.num}`)
  })
})

describe("optLabel — a sentinel is not a quantity", () => {
  test("a negative sentinel renders its word ALONE, with no misleading count", () => {
    expect(optLabel({ word: "disabled", num: -1 }, t)).toBe(en["settings.models.config.preset.disabled"])
    expect(optLabel({ word: "disabled", num: -1 }, t)).not.toContain("-1")
  })

  test("a positive word carries its number", () => {
    expect(optLabel({ word: "balanced", num: 0.7 }, t)).toContain("(0.7)")
  })

  test("a blank preset is the default label, and a size is literal", () => {
    expect(optLabel({}, t)).toBe(en["settings.models.config.preset.default"])
    expect(optLabel({ size: "32K", num: 32768 }, t)).toBe("32K")
  })
})
