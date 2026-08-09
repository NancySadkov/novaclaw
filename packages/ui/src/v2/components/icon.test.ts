import { describe, expect, test } from "bun:test"
import { isIconName } from "./icon"

describe("the text-field copy affordance", () => {
  test("all three runtime states resolve to real v2 glyphs", () => {
    expect(["copy", "link", "check"].every(isIconName)).toBe(true)
    expect(isIconName("missing-copy-state")).toBe(false)
  })
})
