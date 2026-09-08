import { describe, expect, test } from "bun:test"
import { SessionTitle } from "@novaclaw/core/session/title"

/**
 * A ROOT THAT NAMES NOTHING IS THE LAST GHOST SHAPE.
 *
 * Owner, 2026-08-24: *"agents are ghosts going through walls."* The officer half is closed — an
 * unattributed chat runs as Nova, not as a posture. What was left is the ROW: a root created with
 * neither an agent nor a title showed as the bare *"New session"*, saying neither who it belongs to
 * nor what it is for.
 *
 * ⚠️ Not closed by REFUSING that shape: 85 test call sites create exactly it, and rejection buys a
 * cosmetic gain for a large blast radius. A default that NAMES the row is the proportionate
 * mechanism — and it has to stay a DEFAULT, or the name it holds becomes permanent.
 */

describe("the named default is still a default", () => {
  test("🔴 auto-title may still replace it — otherwise the folder name is forever", () => {
    // `isDefault` is the ONLY state auto-title overwrites. A default outside that pattern would pin
    // a row to its folder name for the life of the chat, which is worse than "New session".
    expect(SessionTitle.isDefault("New session in ledger")).toBe(true)
    expect(SessionTitle.isDefault("New session in my project (v2)")).toBe(true)
  })

  test("the plain and legacy forms still count", () => {
    expect(SessionTitle.isDefault("New session")).toBe(true)
    expect(SessionTitle.isDefault("Child session")).toBe(true)
    expect(SessionTitle.isDefault("New session - 2026-08-24T10:00:00.000Z")).toBe(true)
  })

  test("🔴 a REAL title is still not a default", () => {
    // The control. A pattern loose enough to swallow a user's own title would let auto-title
    // overwrite something a person chose.
    expect(SessionTitle.isDefault("Ledger review")).toBe(false)
    expect(SessionTitle.isDefault("Pictor")).toBe(false)
    expect(SessionTitle.isDefault("Notes in the ledger")).toBe(false)
  })

  test("⚠️ a title that merely STARTS like the default is not one", () => {
    // "New sessions to plan" is a chat about sessions, not an unnamed row.
    expect(SessionTitle.isDefault("New sessions to plan")).toBe(false)
    expect(SessionTitle.isDefault("New session in")).toBe(false)
  })
})
