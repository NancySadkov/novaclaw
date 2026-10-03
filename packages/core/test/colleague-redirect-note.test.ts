import { describe, expect, test } from "bun:test"
import { redirectNoteFor } from "@novaclaw/core/tool/colleague"

// 🔴 A redirect is not a denial. The sender must be told that the officer it named was NOT addressed
// and who actually received the message — otherwise "ask Lacedaemon" reads as delivered to Lacedaemon.
// Measured live 2026-10-03 (owner-held Lacedaemon): the human arm omitted the redirect entirely.
describe("what a rerouted colleague hand-off tells the sender", () => {
  test("names the target it refused to address and the actual recipient", () => {
    const note = redirectNoteFor({ target: "lacedaemon", recipient: "owner", redirected: true })
    expect(note).toContain("lacedaemon is not in your chain of command")
    expect(note).toContain("routed to owner instead")
    expect(note).toContain("message them directly next time")
  })

  test("a direct hand-off carries no note", () => {
    expect(redirectNoteFor({ target: "daedalus", recipient: "daedalus", redirected: false })).toBe("")
    expect(redirectNoteFor({ target: "daedalus", recipient: "daedalus", redirected: undefined })).toBe("")
  })

  test("an unnamed recipient still reads honestly", () => {
    expect(redirectNoteFor({ target: "x", recipient: undefined, redirected: true })).toContain(
      "the next person in the chain",
    )
  })
})
