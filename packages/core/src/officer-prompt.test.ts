import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { OfficerPrompt } from "./officer-prompt"

/**
 * The working style is a SEED for an officer's own prompt, not a block composed around it (owner,
 * 2026-09-17). These pin the two things that make that true: the text is still the pragmatic baseline,
 * and nothing in the kernel composes it as a shared persona any more.
 */
describe("OfficerPrompt", () => {
  test("the default carries the working style, and is deterministic", () => {
    const prompt = OfficerPrompt.DEFAULT_OFFICER_PROMPT
    expect(prompt).toContain("Work pragmatically and capably")
    expect(prompt).toContain("Push back on irrational proposals")
    expect(prompt).toContain("Report only what you observed")
    // Pure constant in, same text out — no clock, no environment.
    expect(OfficerPrompt.DEFAULT_OFFICER_PROMPT).toBe(prompt)
  })

  test("🔴 no shared persona block is composed any more", () => {
    // The defect this replaces: a global persona prepended to EVERY agent, with no way for a
    // roleplayer, a chat companion or an artist to decline text that contradicts its role. The kernel
    // table must not carry a `persona` slot, and the config must not offer a `persona` key.
    const template = readFileSync(new URL("./session/context-template.ts", import.meta.url), "utf8")
    expect(template).not.toContain('name: "persona"')
    const config = readFileSync(new URL("./config.ts", import.meta.url), "utf8")
    expect(config).not.toContain("ConfigPersona")
  })
})
