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
