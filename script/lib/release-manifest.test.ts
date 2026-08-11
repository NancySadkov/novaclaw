import { describe, expect, test } from "bun:test"
import { addRelease, EMPTY, rollbackTargetFor, type Manifest } from "./release-manifest"

const art = (name: string) => ({ name, sha256: "a".repeat(64), bytes: 1 })
const at = (n: number) => `2026-08-${String(n).padStart(2, "0")}T00:00:00.000Z`

const seeded = (): Manifest => {
  let m = addRelease(EMPTY, { version: "0.1.58", released: at(1), artifacts: [art("a.7z")] })
  m = addRelease(m, { version: "0.1.59", released: at(2), artifacts: [art("b.7z")] })
  return m
}

describe("rollback manifest", () => {
  test("newest first, so a download page renders it without sorting", () => {
    expect(seeded().releases.map((r) => r.version)).toEqual(["0.1.59", "0.1.58"])
  })

  test("supersedes points at the PREVIOUS newest, not the next lower number", () => {
    const m = seeded()
    expect(m.releases[0]!.supersedes).toBe("0.1.58")
    expect(m.releases[1]!.supersedes).toBeNull()
    // A hotfix cut after a higher version still supersedes what people actually had installed.
    const hotfix = addRelease(m, { version: "0.1.58.1", released: at(3), artifacts: [art("h.7z")] })
    expect(hotfix.releases[0]!.supersedes).toBe("0.1.59")
  })

  // ⚠️ The property the whole design exists for. The version a user needs is precisely the one that
  // is no longer current, so an entry that can be rewritten is not a rollback target.
  test("REFUSES to overwrite a recorded version", () => {
    expect(() => addRelease(seeded(), { version: "0.1.59", released: at(9), artifacts: [art("x.7z")] })).toThrow(
      /append-only/,
    )
  })

  test("refuses a release with no artifacts — an entry nobody can download", () => {
    expect(() => addRelease(EMPTY, { version: "0.1.59", released: at(1), artifacts: [] })).toThrow(/no artifacts/)
  })

  test("rollbackTargetFor answers the question a stuck user is asking", () => {
    const m = seeded()
    expect(rollbackTargetFor(m, "0.1.59")?.version).toBe("0.1.58")
    // The oldest recorded release has nowhere to go, and says so rather than inventing one.
    expect(rollbackTargetFor(m, "0.1.58")).toBeUndefined()
    expect(rollbackTargetFor(m, "9.9.9")).toBeUndefined()
  })

  test("artifacts are sorted, so a re-recorded drop diffs clean", () => {
    const m = addRelease(EMPTY, {
      version: "1.0.0",
      released: at(1),
      artifacts: [art("z.dmg"), art("a.7z")],
    })
    expect(m.releases[0]!.artifacts.map((a) => a.name)).toEqual(["a.7z", "z.dmg"])
  })
})
