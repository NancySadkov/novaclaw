import { describe, expect, test } from "bun:test"
import {
  makeDefaultPayload,
  planMakeDefault,
  PROJECT_SUPERVISION_FEATURES,
  PROJECT_TUNE_FEATURES,
} from "./make-default"

/**
 * `todo/projects.md`: *"Add **Make Default for this Folder** to the Tune dialogue … show the
 * resulting change and a local receipt."*
 *
 * What is asserted here is the SENTENCE the panel prints before the button, because getting it wrong
 * is silent: the write still succeeds, the receipt is still cheerful, and the user has been told the
 * opposite of what happened.
 */

describe("what Make Default will write", () => {
  test("🔴 only the switches this chat DECLARED — an untouched switch stays absent", () => {
    // The trap: the panel shows eight toggles, all reading On or Off. Capturing all eight writes a
    // file that pins the folder against every later change to the user's own Settings, which is what
    // "absent means INHERIT" exists to prevent.
    const plan = planMakeDefault({ memory: true, quality: false })
    expect(plan.declared.map((entry) => entry.feature)).toEqual(["memory", "quality"])
    expect(makeDefaultPayload(plan)).toEqual({ memory: true, quality: false })
  })

  test("nothing declared means nothing to write — the button has no work to do", () => {
    const plan = planMakeDefault({})
    expect(plan.declared).toEqual([])
    expect(plan.persisted).toEqual([])
    expect(makeDefaultPayload(plan)).toEqual({})
  })

  test("switches the file cannot carry are dropped before they are ever offered", () => {
    // `shortChat` and `thinkingBudget` are per-chat only. Offering to persist one would produce a
    // file the kernel drops on read with nothing said to anyone.
    const plan = planMakeDefault({ shortChat: true, thinkingBudget: false, memory: true })
    expect(plan.declared.map((entry) => entry.feature)).toEqual(["memory"])
  })

  test("🔴 a supervision switch turned OFF is shown as omitted, not as something being saved", () => {
    const plan = planMakeDefault({ safeMode: false, askBeforeChanges: false, memory: false })
    expect(plan.omitted.map((entry) => entry.feature)).toEqual(["safeMode", "askBeforeChanges"])
    // `memory: false` is a PREFERENCE — it goes in. Only the two rails are held back.
    expect(plan.persisted.map((entry) => entry.feature)).toEqual(["memory"])
  })

  test("a supervision switch turned ON is saved like any other", () => {
    const plan = planMakeDefault({ safeMode: true })
    expect(plan.omitted).toEqual([])
    expect(plan.persisted.map((entry) => entry.feature)).toEqual(["safeMode"])
  })

  test("🔴 the payload still carries what will be dropped, so the SERVER reports the refusal", () => {
    // Sending only what the client already believes is allowed would make the receipt's `refused`
    // list permanently empty — the client agreeing with itself instead of being told.
    const plan = planMakeDefault({ safeMode: false, memory: true })
    expect(makeDefaultPayload(plan)).toEqual({ safeMode: false, memory: true })
  })

  test("the order is the file's, not the caller's object order", () => {
    const plan = planMakeDefault({ affective: true, safeMode: true, memory: true })
    expect(plan.declared.map((entry) => entry.feature)).toEqual(["safeMode", "memory", "affective"])
  })

  test("the supervision list is a subset of what a project file may carry at all", () => {
    for (const feature of PROJECT_SUPERVISION_FEATURES) expect(PROJECT_TUNE_FEATURES).toContain(feature)
    expect(PROJECT_TUNE_FEATURES.length).toBe(8)
  })
})
