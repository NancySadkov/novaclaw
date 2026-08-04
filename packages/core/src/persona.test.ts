import { describe, expect, test } from "bun:test"
import { Persona } from "./persona"

describe("Persona.resolve", () => {
  test("defaults to the canonical Nova prompt when config is absent", () => {
    const result = Persona.resolve(undefined)
    expect(result).toBeDefined()
    expect(result).toContain("Nova")
    expect(result).toContain("pragmatic")
  })

  test("enabled: false disables the persona entirely (notes line included)", () => {
    expect(Persona.resolve({ enabled: false }, { notesDir: "/data/notes" })).toBeUndefined()
  })

  test("enabled: true and undefined behave the same (default on)", () => {
    expect(Persona.resolve({ enabled: true })).toBe(Persona.resolve(undefined))
    expect(Persona.resolve({})).toBe(Persona.resolve(undefined))
  })

  test("name swaps the persona name without forking the text", () => {
    const result = Persona.resolve({ name: "Vega" })!
    expect(result).toContain("Vega")
    expect(result).not.toContain("Nova")
  })

  test("blank name falls back to the default", () => {
    expect(Persona.resolve({ name: "  " })).toContain("Nova")
  })

  test("prompt overrides the canonical text wholesale", () => {
    const result = Persona.resolve({ prompt: "You are a terse reviewer." })!
    expect(result).toContain("You are a terse reviewer.")
    expect(result).not.toContain("pragmatic")
  })

  test("blank prompt override falls back to the default", () => {
    expect(Persona.resolve({ prompt: "   " })).toContain("pragmatic")
  })

  test("notes line rides along when a notes dir is known — even with a custom prompt", () => {
    const custom = Persona.resolve({ prompt: "Custom." }, { notesDir: "D:\\data\\notes" })!
    expect(custom).toContain("Custom.")
    expect(custom).toContain("D:\\data\\notes")
    const stock = Persona.resolve(undefined, { notesDir: "/srv/notes" })!
    expect(stock).toContain("/srv/notes")
  })

  test("no notes dir -> no notes line", () => {
    expect(Persona.resolve(undefined)).not.toContain("notes folder")
  })

  // 1M/A6(2) — size pin (codehamr discipline: "bump when it fails, never relax the assertion").
  // The persona baseline is charged against EVERY turn's context on the qwen floor; growth must be
  // a deliberate decision, not drift. Currently ~1.4k chars (~350 tokens).
  test("size pin: the composed baseline stays under 2000 chars", () => {
    const composed = Persona.resolve(undefined, { notesDir: "C:\\Users\\example\\data\\notes" })!
    expect(composed.length).toBeLessThan(2000)
  })
})
