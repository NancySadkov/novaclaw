import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * 🔴 **The chat's model override belongs to the SESSION, and the session owns it alone.**
 *
 * The bug this pins (owner, 2026-09-16): *"I switched its model from default to qwen3.8-flash, but it
 * kept using deepseek-flash."* Measured in the live store, `agent_config.daedalus.model` was the
 * qwen3.8 ref while `session.ses_daedalus.model` still held deepseek. The session column outranks the
 * officer by design, so that alone explains it — but the reason nobody could SEE it was a second
 * answer: the composer kept a durable per-session pick in this client, and that shadow outranked
 * everything while being invisible to the kernel and to every other client.
 *
 * So the rule is one source of truth. The kernel component (`session.switchModel`,
 * `session.next.model.switched`) is the chat's override; the composer READS it and WRITES it, and a
 * pre-session draft stages a pick in memory until `create`. `overridden()` makes the override
 * legible and offers the way back, because the keystone (`undefined = inherit`) means a deliberate
 * chat choice must survive an officer re-point rather than being cleared behind the user's back.
 *
 * A behavioural test cannot catch the old regression — a chat whose pick and resolution happen to
 * agree passes either way — so the distinction lives in which SOURCE the call site reads, and the
 * guard reads the call site.
 */
const submit = fs.readFileSync(path.join(import.meta.dir, "submit.ts"), "utf8")
const local = fs.readFileSync(path.join(import.meta.dir, "..", "..", "context", "local.tsx"), "utf8")
const picker = fs.readFileSync(path.join(import.meta.dir, "..", "dialog-select-model.tsx"), "utf8")
const officerDialog = fs.readFileSync(path.join(import.meta.dir, "..", "officer-settings-screen.tsx"), "utf8")

describe("a chat's model is an override the session owns", () => {
  test("🔴 the composer sends what THIS CHAT picked, never what it resolved to", () => {
    expect(submit).toContain("const picked = input.draft.override")
    expect(submit).toContain("const currentOverride = local.model.override()")
  })

  test("🔴 the kernel session row is the ONE source of truth for the override", () => {
    // The composer reads the session component for an existing chat...
    expect(local).toContain("sync().session.get(session)?.model")
    // ...and keeps no durable client copy — a second copy is what made the question answerable two
    // ways. `modelFor` was the stopgap that scoped a shadow; the migration deletes the shadow.
    expect(local).not.toContain("modelFor")
  })

  test("🔴 picking a model for an existing session writes the KERNEL, not a local copy", () => {
    expect(local).toMatch(/\.switchModel\(\{\s*sessionID: session,\s*model: \{/)
    // Returning to the officer's model is the same kernel write with `null`.
    expect(local).toContain(".switchModel({ sessionID: session, model: null })")
  })

  test("🔴 the model control says when a chat overrides its officer, and offers the way back", () => {
    // Principle 12: say what is in force, and make the one-click repair reachable. This is what the
    // owner's report was actually missing — the override was real but silent.
    expect(local).toContain("const overridden = ()")
    expect(picker).toContain("model.overridden?.()")
    expect(picker).toContain("dialog.model.override.follow")
  })

  test("re-pointing an officer does NOT silently clear a chat's explicit override", () => {
    // The keystone is `undefined = inherit`: an override is a deliberate sparse choice and survives.
    // Legibility above is how the user changes their mind — not a hidden cascade from an edit to a
    // different field on the officer.
    expect(officerDialog).not.toContain("switchModel({ sessionID: chat.id, model: null })")
  })
})
