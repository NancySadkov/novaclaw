import { describe, expect, test } from "bun:test"
import { ProjectFile } from "@novaclaw/schema/project-file"

/**
 * `todo/projects.md`, first item: version the format, *"reject unknown schema versions calmly;
 * preserve unknown fields when a newer file is edited by an older NovaClaw."*
 *
 * Both halves are failures that produce no error anywhere — a refusal that reads as corruption, and
 * an edit that silently deletes what it did not understand — so they get tests rather than care.
 */

const write = (value: unknown) => JSON.stringify(value, null, 2)

describe("novaclaw.json", () => {
  test("an empty project is valid — a folder may declare nothing but itself", () => {
    const result = ProjectFile.parse(write({ version: 1 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.info.name).toBeUndefined()
    expect(result.info.permissions).toBeUndefined()
  })

  test("reads the sections it knows", () => {
    const result = ProjectFile.parse(
      write({ version: 1, name: "Acme", exclude: ["secrets/**"], policies: ["policy.review"] }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.info.name).toBe("Acme")
    expect(result.info.exclude).toEqual(["secrets/**"])
    expect(result.info.policies).toEqual(["policy.review"])
  })

  test("🔴 a FUTURE version is refused by name, not as corruption", () => {
    // "Your file is broken" and "your NovaClaw is old" call for opposite reactions. A single
    // `invalid` would send half of these users to the wrong one.
    const result = ProjectFile.parse(write({ version: ProjectFile.VERSION + 1, name: "From tomorrow" }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("future-version")
    expect(result.detail).toContain(`understands up to ${ProjectFile.VERSION}`)
  })

  test("🔴 a future version wins over a shape error — the version is checked FIRST", () => {
    // A newer file will often also fail to decode. Reporting THAT tells the user their file is
    // broken when the truth is that their build is old, and the order of two checks decides which
    // sentence they read.
    const result = ProjectFile.parse(write({ version: 99, exclude: "not-an-array" }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("future-version")
  })

  test("malformed JSON is `unreadable`, not a throw", () => {
    const result = ProjectFile.parse("{ this is not json")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("unreadable")
  })

  test("a non-object, and a missing version, are named separately from corruption", () => {
    expect(ProjectFile.parse("[]").ok).toBe(false)
    const noVersion = ProjectFile.parse(write({ name: "no version" }))
    expect(noVersion.ok).toBe(false)
    if (noVersion.ok) return
    expect(noVersion.detail).toContain("version")
  })

  test("🔴 an edit PRESERVES sections this build does not understand", () => {
    // The defect: a newer NovaClaw writes a section we have no type for, the user edits one setting
    // in the UI on an older build, and serialising the decoded view deletes the rest — no error
    // anywhere, and the loss is only visible on the machine that wrote it.
    const source = write({
      version: 1,
      name: "Acme",
      tune: { context: { profiles: { "goal-oriented": { system: 20 } } } },
      somethingFromTheFuture: { deeply: { nested: true } },
    })
    const parsed = ProjectFile.parse(source)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const next = ProjectFile.merge(parsed.raw, { name: "Acme Renamed" })
    const written = JSON.parse(ProjectFile.format(next)) as Record<string, unknown>
    expect(written["name"]).toBe("Acme Renamed")
    expect(written["tune"]).toEqual({ context: { profiles: { "goal-oriented": { system: 20 } } } })
    expect(written["somethingFromTheFuture"]).toEqual({ deeply: { nested: true } })
  })

  test("a merge REPLACES a section wholesale rather than deep-merging it", () => {
    // A deep merge cannot tell "leave this alone" from "empty this list", and the caller holds the
    // whole section anyway.
    const parsed = ProjectFile.parse(write({ version: 1, exclude: ["a/**", "b/**"] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const next = ProjectFile.merge(parsed.raw, { exclude: ["c/**"] })
    expect(next["exclude"]).toEqual(["c/**"])
  })

  test("`undefined` CLEARS a section instead of writing invalid JSON", () => {
    const parsed = ProjectFile.parse(write({ version: 1, name: "Acme", exclude: ["a/**"] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const next = ProjectFile.merge(parsed.raw, { exclude: undefined })
    expect("exclude" in next).toBe(false)
    // …and the untouched sections survive the clearing.
    expect(next["name"]).toBe("Acme")
    expect(ProjectFile.format(next)).not.toContain("undefined")
  })

  test("the written file is diffable — two-space indent, trailing newline", () => {
    const text = ProjectFile.format({ version: 1, name: "Acme" })
    expect(text.endsWith("\n")).toBe(true)
    expect(text).toContain('\n  "name": "Acme"')
  })
})

/**
 * The `tune` section and its narrowing algebra.
 *
 * 🔴 These are the tune half of the hazard `evaluateNarrowed` exists for on the permissions half: a
 * repository the user cloned five minutes ago must not be able to disarm their supervision or start
 * agents that run unattended. None of these fields LOOKS like a permission, which is exactly why the
 * rule needs tests rather than a comment.
 */
describe("novaclaw.json tune", () => {
  test("reads a tune section, absent switches staying absent", () => {
    const result = ProjectFile.parse(write({ version: 1, tune: { features: { memory: false } } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.info.tune?.features?.memory).toBe(false)
    // Absent means INHERIT, so it must not decode to `false`.
    expect(result.info.tune?.features?.quality).toBeUndefined()
  })

  test("🔴 an unattended mode is not even expressible", () => {
    // The schema is the enforcement for `mode`. If someone later widens the literal, this fails and
    // sends them to `narrowTune`'s comment rather than letting a cloned repo auto-prompt itself.
    for (const mode of ["goal-oriented", "auto-prompting"]) {
      expect(ProjectFile.parse(write({ version: 1, tune: { mode } })).ok).toBe(false)
    }
    // ⚠️ NEGATIVE CONTROL. Without it this test passes for any reason at all — a typo'd key, a
    // schema that rejects every tune section, a `version` mistake — and would keep passing after
    // someone broke the section entirely. The same file with the allowed mode must parse.
    const allowed = ProjectFile.parse(write({ version: 1, tune: { mode: "interactive" } }))
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    expect(allowed.info.tune?.mode).toBe("interactive")
  })

  test("a preference switch may go either way", () => {
    const both = ProjectFile.narrowTune({ features: { memory: false, quality: true } }, { memory: true, quality: false })
    expect(both.features).toEqual({ memory: false, quality: true })
    expect(both.refused).toEqual([])
  })

  test("🔴 a supervision switch may be RAISED but never lowered", () => {
    const raise = ProjectFile.narrowTune({ features: { safeMode: true } }, { safeMode: false })
    expect(raise.features).toEqual({ safeMode: true })
    expect(raise.refused).toEqual([])

    // The attack: the folder's file says "no safe mode" while the user's own default says yes.
    const lower = ProjectFile.narrowTune({ features: { safeMode: false } }, { safeMode: true })
    expect(lower.features).toEqual({})
    expect(lower.refused).toEqual(["safeMode"])
  })

  test("lowering a supervision switch the user already had OFF is a no-op, not a refusal", () => {
    // Nothing is taken away, so there is nothing to refuse — reporting one would train the user to
    // ignore the warning that matters.
    const result = ProjectFile.narrowTune({ features: { askBeforeChanges: false } }, { askBeforeChanges: false })
    expect(result.features).toEqual({ askBeforeChanges: false })
    expect(result.refused).toEqual([])
  })

  test("both supervision switches are policed, and the list is the source of truth", () => {
    for (const feature of ProjectFile.SUPERVISION_FEATURES) {
      const result = ProjectFile.narrowTune({ features: { [feature]: false } }, { [feature]: true })
      expect(result.refused).toEqual([feature])
      expect(ProjectFile.isSupervisionFeature(feature)).toBe(true)
    }
  })

  test("an absent tune section narrows to nothing at all", () => {
    expect(ProjectFile.narrowTune(undefined, { safeMode: true })).toEqual({ features: {}, refused: [] })
  })

  test("a tune edit preserves sections this build does not know", () => {
    // The whole point of merging onto the RAW object rather than the decoded view.
    const parsed = ProjectFile.parse(write({ version: 1, tune: { features: { memory: true } }, futureThing: { a: 1 } }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const merged = ProjectFile.merge(parsed.raw, { tune: { features: { memory: false } } })
    expect(merged["futureThing"]).toEqual({ a: 1 })
    expect((merged["tune"] as { features: Record<string, boolean> }).features.memory).toBe(false)
  })
})

/**
 * `narrowTune`'s twin on the WRITE side. The read side is the enforcement — it is the only one an
 * attacker's file goes through — so what is asserted here is TRUTHFULNESS: our own writer never puts
 * a sentence in a file that the reader is guaranteed to refuse the moment it would matter.
 */
describe("what a write may record", () => {
  test("🔴 a supervision switch is never recorded as OFF — it is omitted, and reported", () => {
    const result = ProjectFile.writableTune({ features: { safeMode: false, askBeforeChanges: false } })
    // Absent means INHERIT, which is exactly "this folder takes no position on your safety rails" —
    // and it is the only encoding of that. Writing `false` would say something else entirely.
    expect(result.tune?.features).toEqual({})
    expect(result.refused).toEqual(["safeMode", "askBeforeChanges"])
  })

  test("raising supervision is written normally", () => {
    const result = ProjectFile.writableTune({ features: { safeMode: true, askBeforeChanges: true } })
    expect(result.tune?.features).toEqual({ safeMode: true, askBeforeChanges: true })
    expect(result.refused).toEqual([])
  })

  test("a PREFERENCE switch is written either way — none of them widens what an agent may do", () => {
    const result = ProjectFile.writableTune({
      features: { memory: false, quality: false, affective: true, surgicalEdits: false },
    })
    expect(result.tune?.features).toEqual({ memory: false, quality: false, affective: true, surgicalEdits: false })
    expect(result.refused).toEqual([])
  })

  test("the mode survives, and `interactive` is the only one the type admits", () => {
    const result = ProjectFile.writableTune({ mode: "interactive", features: { memory: true } })
    expect(result.tune?.mode).toBe("interactive")
  })

  test("no tune at all is not a tune section", () => {
    expect(ProjectFile.writableTune(undefined)).toEqual({ tune: undefined, refused: [] })
  })

  test("🔴 whatever a write records, the read side then accepts unchanged", () => {
    // The join: run every switch through the writer at its most permissive setting, then read it
    // back against the most hostile baseline (every rail already ON). A writable tune that the
    // reader still refuses would mean the file says one thing and the product does another.
    const asked = Object.fromEntries(ProjectFile.TUNE_FEATURES.map((feature) => [feature, false]))
    const written = ProjectFile.writableTune({ features: asked })
    const baseline = Object.fromEntries(ProjectFile.SUPERVISION_FEATURES.map((feature) => [feature, true]))
    const read = ProjectFile.narrowTune(written.tune, baseline)
    expect(read.refused).toEqual([])
    expect(read.features).toEqual(written.tune?.features ?? {})
  })
})
