import { describe, expect, test } from "bun:test"
import { Persona } from "./persona"

describe("Persona.resolve", () => {
  test("defaults to a role-neutral harness prompt when config is absent", () => {
    const result = Persona.resolve(undefined)
    expect(result).toBeDefined()
    expect(result).toContain("pragmatic")
    expect(result).not.toContain("software engineer")
    expect(result).not.toContain("Nova")
  })

  test("enabled: false disables the persona entirely (notes line included)", () => {
    expect(Persona.resolve({ enabled: false }, { notesDir: "/data/notes" })).toBeUndefined()
  })

  test("enabled: true and undefined behave the same (default on)", () => {
    expect(Persona.resolve({ enabled: true })).toBe(Persona.resolve(undefined))
    expect(Persona.resolve({})).toBe(Persona.resolve(undefined))
  })

  test("prompt overrides the canonical text wholesale", () => {
    const result = Persona.resolve({ prompt: "You are a terse reviewer." })!
    expect(result).toContain("You are a terse reviewer.")
    expect(result).not.toContain("pragmatic")
  })

  test("blank prompt override falls back to the default", () => {
    expect(Persona.resolve({ prompt: "   " })).toContain("pragmatic")
  })

  test("routine ambiguity proceeds while materially different outcomes still ask", () => {
    const prompt = Persona.resolve(undefined)!
    expect(prompt).toContain("Make routine judgment calls yourself")
    expect(prompt).toContain("plausible interpretations would materially change the result")
    expect(prompt).toContain("finish everything that does not depend on the answer")
    expect(prompt).not.toContain("If a prompt is ambiguous, ask for clarification")
  })

  test("completion claims are tied to observed evidence", () => {
    const prompt = Persona.resolve(undefined)!
    expect(prompt).toContain("Report only what you observed")
    expect(prompt).toContain("lead with failures, skipped checks, or incomplete work")
    expect(prompt).toContain("unverified")
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

  // The persona baseline is charged against EVERY turn's context on the floor model. The behavior
  // contract above replaced a longer baseline; pin the smaller budget rather than spending the
  // reclaimed context on new prose later.
  test("size pin: the composed baseline stays under 1200 chars", () => {
    const composed = Persona.resolve(undefined, { notesDir: "C:\\Users\\example\\data\\notes" })!
    expect(composed.length).toBeLessThan(1200)
  })
})
