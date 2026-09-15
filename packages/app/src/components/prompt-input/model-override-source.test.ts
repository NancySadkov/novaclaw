import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * 🔴 The composer sends what THIS CHAT PICKED, never what it resolved to.
 *
 * The bug this pins is invisible at runtime and expensive to find afterwards, which is why it is a
 * source scan rather than a behavioural test. `local.model.current()` is the model a chat will RUN on
 * — `firstModel(scope()?.model, agent.current()?.model, fallback)` (`context/local.tsx:241`). Shipping
 * THAT value through `switchModel` wrote the resolved answer into `session.model`, and a written row
 * outranks the officer forever (`runner/model.ts` `select()` prefers the row). The result, visible in
 * the live database: nearly every `session` row pinned to one model with `session.agent` NULL — every
 * chat permanently deaf to its officer's re-pointing, and no way back.
 *
 * A behavioural test cannot catch the regression, because a chat whose pick and resolution happen to
 * agree passes either way. The distinction lives in which EXPRESSION the call site reads, so the
 * guard reads the call site.
 */
const submit = fs.readFileSync(path.join(import.meta.dir, "submit.ts"), "utf8")
const local = fs.readFileSync(path.join(import.meta.dir, "..", "..", "context", "local.tsx"), "utf8")
const officerDialog = fs.readFileSync(path.join(import.meta.dir, "..", "agent-config-dialog.tsx"), "utf8")

describe("a chat's model is an override, not a snapshot", () => {
  test("🔴 the per-turn switch reads the draft's own pick", () => {
    expect(submit).toContain("const picked = input.draft.override")
  })

  test("🔴 and a chat that never picked actively CLEARS its row", () => {
    // Without this the pre-Fix-D rows never heal: clearing is what makes existing pinned sessions
    // follow their officer again on the next prompt, instead of needing a data migration.
    expect(submit).toMatch(/switchModel\(\{\s*sessionID:[^}]*model:\s*null\s*\}\)/)
  })

  test("🔴 no resolved value is read inline inside a switch call", () => {
    // `current()` is right for DISPLAY and wrong for PERSISTENCE. Scope note, learned by mutating this
    // file: this scan sees only what a call reads INLINE. The regression in its most likely form —
    // the assignment site quietly switching `draft.override` → `draft.model` — is caught by the first
    // test, not this one. Keep both; neither alone covers the door.
    const switchCalls = submit.split("switchModel(").slice(1)
    expect(switchCalls.length).toBeGreaterThan(0)
    for (const call of switchCalls) {
      const body = call.slice(0, call.indexOf("})") + 2)
      expect(body).not.toMatch(/model\.current\(\)/)
      expect(body).not.toMatch(/draft\.model\b/)
    }
  })

  test("the slash-command path sends a model only when there is a pick", () => {
    // An unconditional `model:` here would re-introduce the pin through a side door, because the
    // command payload is built from a resolved string.
    expect(submit).toMatch(/currentOverride\s*\?\s*\{\s*model:/)
  })

  test("the app exposes the pick separately from the resolution", () => {
    // `override()` is the whole point of the Fix D surface: two questions, two answers. Pin the
    // DEFINITION, not just the name — it must read the FIRST LINK of the chain and nothing else.
    // If someone widens it to `current()`'s walk, the scan above has nothing left to distinguish.
    expect(local).toMatch(/const override = \(\) => pickedModel\(\)/)
    // ...and that it is actually handed out on the `model` object, not left dead in the file.
    expect(local).toMatch(/\bmodel = \{[\s\S]{0,400}?\n\s*override,\n/)
  })

  test("🔴 a chat pick is scoped to the officer assignment it was made under", () => {
    // Owner, 2026-09-16: *"I switched its model from default to qwen3.8-flash, but it kept using
    // deepseek-flash."* Measured in the live store: daedalus's officer model was qwen3.8 while the
    // session row still pinned deepseek, and the composer read the chat pick first. A pick that
    // predates the current officer assignment must not outrank it.
    expect(local).toContain("state.modelFor !== officerModelRef()")
    expect(local).toContain("modelFor: officerModelRef()")
    // The DISPLAY chain reads the scoped pick too, or the composer would show a model the row will
    // not honor.
    expect(local).toMatch(/const current = \(\) => \{\s*const item = firstModel\(\s*\(\) => pickedModel\(\),/)
  })

  test("🔴 re-pointing an officer clears its chat's server-side override", () => {
    // The composer reconciles on submit, but the provider-recovery dock's Resume and a headless turn
    // do not — so the officer's own settings surface must heal the row when the model CHANGES.
    expect(officerDialog).toContain("switchModel({ sessionID: chat.id, model: null })")
    expect(officerDialog).toContain("model() !== modelBefore")
    // A personality edit must never repoint a chat: the clear is gated on a changed model.
    expect(officerDialog).toMatch(/if \(model\(\) !== undefined && model\(\) !== modelBefore\)/)
  })
})
