import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import {
  inForceState,
  makeDefaultPayload,
  planMakeDefault,
  PROJECT_SUPERVISION_FEATURES,
  PROJECT_TUNE_FEATURES,
} from "./make-default"

/**
 * The brief: *"add **Make Default for this Folder** to the Tune dialogue … show the
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

/**
 * ─── what governs this folder RIGHT NOW ─────────────────────────────────────────────────────────
 *
 * Measured FALSE in the packaged app 2026-08-18 (D4 in
 * `notes/reports/electron-render-gates-2026-08-18.md`): a draft chat always read "This folder has no
 * project file yet. Saving creates one here." — including in a folder holding a valid file, and in a
 * folder whose file was present but unreadable, one second before the write was refused.
 */
describe("inForceState", () => {
  // The real caller injects `pathKey`. This stand-in only needs to normalise a trailing separator
  // and case, which is what the separator case below exercises.
  const norm = (value: string) => value.toLowerCase().replace(/[/]+$/, "")
  const samePath = (a: string, b: string) => norm(a) === norm(b)
  const folder = "C:/work/app"

  test("a resolved layer WINS over the directory probe — it knows strictly more", () => {
    // Both present and disagreeing: the layer decides. A probe that could override it would be the
    // "two authorities on what is in force" mistake.
    const state = inForceState({
      folder,
      governedBy: { root: folder, file: `${folder}/novaclaw.json` },
      discovered: { kind: "none" },
      samePath,
    })
    expect(state).toEqual({ kind: "here", file: `${folder}/novaclaw.json` })
  })

  test("an ancestor layer is named as an ancestor, not as this folder's own", () => {
    const state = inForceState({
      folder,
      governedBy: { root: "C:/work", file: "C:/work/novaclaw.json" },
      discovered: undefined,
      samePath,
    })
    expect(state).toEqual({ kind: "ancestor", file: "C:/work/novaclaw.json" })
  })

  test("NO ANSWER YET is not an absence — this is the whole defect", () => {
    // The old code sent `undefined` to the "no project file yet" copy, asserting an absence about a
    // folder nobody had looked at.
    expect(inForceState({ folder, discovered: undefined, samePath })).toEqual({ kind: "pending" })
  })

  test("an answered 'none' IS an absence, so the create copy is true", () => {
    expect(inForceState({ folder, discovered: { kind: "none" }, samePath })).toEqual({ kind: "none" })
  })

  test("a discovered file in THIS folder never claims to know what it sets", () => {
    // `GET /api/project` carries no `applied`, so there is nothing honest to summarise. Rendering an
    // empty applied list would print "it sets nothing" — a different false statement.
    const state = inForceState({
      folder,
      discovered: { kind: "project", root: folder, file: `${folder}/novaclaw.json` },
      samePath,
    })
    expect(state).toEqual({ kind: "here-unknown", file: `${folder}/novaclaw.json` })
  })

  test("a discovered file ABOVE this folder is distinguished from one in it", () => {
    const state = inForceState({
      folder,
      discovered: { kind: "project", root: "C:/work", file: "C:/work/novaclaw.json" },
      samePath,
    })
    expect(state).toEqual({ kind: "ancestor-unknown", file: "C:/work/novaclaw.json" })
  })

  test("a broken file says so, and separates 'fix it' from 'upgrade me'", () => {
    const broken = inForceState({
      folder,
      discovered: { kind: "invalid", file: `${folder}/novaclaw.json`, reason: "unreadable" },
      samePath,
    })
    expect(broken).toEqual({ kind: "broken", file: `${folder}/novaclaw.json`, future: false })
    const future = inForceState({
      folder,
      discovered: { kind: "invalid", file: `${folder}/novaclaw.json`, reason: "future-version" },
      samePath,
    })
    expect(future).toEqual({ kind: "broken", file: `${folder}/novaclaw.json`, future: true })
  })

  test("path comparison is not string equality — a separator difference is the same folder", () => {
    // The two strings come from the browser's session record and the server's `path.resolve`.
    const state = inForceState({
      folder,
      discovered: { kind: "project", root: `${folder}/`, file: `${folder}/novaclaw.json` },
      samePath,
    })
    expect(state.kind).toBe("here-unknown")
  })

  test("every state has copy, and no two sentences are duplicates", () => {
    // Seven keys for eight states: `ancestor-unknown` deliberately reuses `ancestor`, because that
    // sentence never claims what the file sets, so knowing `applied` would change nothing about it.
    // Two identical strings under different keys is two things to keep in step for no visible gain —
    // this assertion is what caught the duplicate when there WAS one.
    const keys = [
      "composer.tune.makeDefault.inForce.pending",
      "composer.tune.makeDefault.inForce.none",
      "composer.tune.makeDefault.inForce.here",
      "composer.tune.makeDefault.inForce.ancestor",
      "composer.tune.makeDefault.inForce.hereUnknown",
      "composer.tune.makeDefault.inForce.brokenUnreadable",
      "composer.tune.makeDefault.inForce.brokenFuture",
    ] as const
    const sentences = keys.map((key) => en[key])
    for (const [index, sentence] of sentences.entries()) expect(sentence, keys[index]).toBeTruthy()
    expect(new Set(sentences).size).toBe(keys.length)
    // The two states that must never read as "there is no file" — the original defect.
    expect(en["composer.tune.makeDefault.inForce.hereUnknown"]).not.toContain("no project file")
    expect(en["composer.tune.makeDefault.inForce.brokenUnreadable"]).not.toContain("no project file")
  })
})
