import { describe, expect, test } from "bun:test"

import { createAutosave } from "./notes-autosave"

/**
 * 🔴 NC-REL-038 — an older autosave cleared a newer edit's dirty bit, and navigation then discarded
 * the newer edit. Every write called `setDirty(false)` unconditionally, without asking whether the
 * editor had moved on since that write captured its content.
 *
 * A/B: make `settles()` return `true` unconditionally and "a write that started before the last
 * keystroke does not settle" fails — which is the data loss.
 */
describe("the notes autosave guard", () => {
  test("🔴 a write that started BEFORE the last keystroke does not settle", () => {
    const autosave = createAutosave()
    autosave.edited() // the user types
    autosave.begin() // the debounce fires; this write carries that text
    autosave.edited() // the user types again while it is in flight
    // The write finishes. It wrote real bytes — but it does not speak for what is on screen now.
    expect(autosave.settles()).toBe(false)
  })

  test("a write that carried the last keystroke settles", () => {
    // The control: without it, "never settles" would satisfy the test above and leave the indicator
    // stuck at unsaved forever.
    const autosave = createAutosave()
    autosave.edited()
    autosave.begin()
    expect(autosave.settles()).toBe(true)
  })

  test("a second write after the newer edit settles again", () => {
    // The recovery path: the debounce re-fires, that write carries the newer text, and the flag can
    // finally clear. Otherwise the fix would trade lost text for a permanently dirty editor.
    const autosave = createAutosave()
    autosave.edited()
    autosave.begin()
    autosave.edited()
    expect(autosave.settles()).toBe(false)
    autosave.begin()
    expect(autosave.settles()).toBe(true)
  })

  test("an untouched editor settles — nothing to lose", () => {
    const autosave = createAutosave()
    autosave.begin()
    expect(autosave.settles()).toBe(true)
  })
})
