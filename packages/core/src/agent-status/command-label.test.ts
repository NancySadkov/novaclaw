import { describe, expect, test } from "bun:test"
import { cleanCommandLabel } from "./command-label"

describe("command label cleanup", () => {
  test("keeps one short human title", () => {
    expect(cleanCommandLabel('"Inspect the recent app errors."')).toBe("Inspect the recent app errors")
  })

  test("caps a verbose answer at five words", () => {
    expect(cleanCommandLabel("Search all the project files for avatar references")).toBe("Search all the project files")
  })

  test("rejects empty and code-shaped output", () => {
    expect(cleanCommandLabel("{}")).toBeUndefined()
    expect(cleanCommandLabel("---")).toBeUndefined()
  })
})
