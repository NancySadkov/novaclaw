import { describe, expect, test } from "bun:test"
import { ChangesetBudget } from "./changeset-budget"

describe("withinBudget", () => {
  test("room under both caps", () => expect(ChangesetBudget.withinBudget({ files: 10, bytes: 1000 })).toBe(true))
  test("file count cap stops it", () =>
    expect(ChangesetBudget.withinBudget({ files: ChangesetBudget.MAX_DIFF_FILES, bytes: 0 })).toBe(false))
  test("byte cap stops it", () =>
    expect(ChangesetBudget.withinBudget({ files: 0, bytes: ChangesetBudget.MAX_DIFF_BYTES })).toBe(false))
  test("custom limits honored", () =>
    expect(ChangesetBudget.withinBudget({ files: 5, bytes: 0 }, { maxFiles: 5 })).toBe(false))
})

describe("exceededBy", () => {
  test("count when files cap hit first", () =>
    expect(ChangesetBudget.exceededBy({ files: ChangesetBudget.MAX_DIFF_FILES, bytes: 0 })).toBe("count"))
  test("bytes when only byte cap hit", () =>
    expect(ChangesetBudget.exceededBy({ files: 0, bytes: ChangesetBudget.MAX_DIFF_BYTES })).toBe("bytes"))
})

describe("omittedPatch", () => {
  test("count reason mentions file budget", () =>
    expect(ChangesetBudget.omittedPatch("count", { maxFiles: 42 })).toContain("42-file"))
  test("bytes reason mentions MB budget", () =>
    expect(ChangesetBudget.omittedPatch("bytes", { maxBytes: 2 * 1024 * 1024 })).toContain("2 MB"))
})

describe("summary", () => {
  test("undefined when everything was diffed", () => expect(ChangesetBudget.summary(10, 10, 1000)).toBeUndefined())
  test("reports total, computed, and omitted counts", () => {
    const s = ChangesetBudget.summary(5000, 300, 4 * 1024 * 1024)
    expect(s).toContain("5000 files changed")
    expect(s).toContain("first 300")
    expect(s).toContain("4700 more")
  })
})

describe("list cap (1G)", () => {
  test("truncatedListLabel names the omitted count", () =>
    expect(ChangesetBudget.truncatedListLabel(4500)).toBe("(+4500 more changed files)"))
  test("truncatedListPatch reports shown/total and reassures about revert", () => {
    const patch = ChangesetBudget.truncatedListPatch(5000, 500)
    expect(patch).toContain("500 of 5000")
    expect(patch).toContain("4500")
    expect(patch).toContain("Revert is unaffected")
  })
})
