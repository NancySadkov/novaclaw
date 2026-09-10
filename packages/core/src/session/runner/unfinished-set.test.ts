import { describe, expect, test } from "bun:test"
import { UnfinishedSet } from "./unfinished-set"

describe("UnfinishedSet.asksForSet", () => {
  test("does not turn whole-task language into a file-set drive", () => {
    expect(UnfinishedSet.asksForSet("Please gather all evidence and file all issues.")).toBe(false)
    expect(UnfinishedSet.asksForSet("Fix every interruption defect in the todo.")).toBe(false)
  })

  test("recognises collection language only when it names enumerable artifacts", () => {
    expect(UnfinishedSet.asksForSet("Describe each glyph here.")).toBe(true)
    expect(UnfinishedSet.asksForSet("Open all the files in this folder.")).toBe(true)
    expect(UnfinishedSet.asksForSet("List the images one by one.")).toBe(true)
    expect(UnfinishedSet.asksForSet("Compare both a.png and b.png.")).toBe(true)
  })
})
