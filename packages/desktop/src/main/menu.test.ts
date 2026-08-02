import { describe, expect, test } from "bun:test"
import fs from "node:fs"

const source = fs.readFileSync(new URL("./menu.ts", import.meta.url), "utf8")

describe("desktop application menu", () => {
  test("removes Electron's default menu outside macOS", () => {
    expect(source).toMatch(
      /if \(process\.platform !== "darwin"\) \{[\s\S]{0,300}Menu\.setApplicationMenu\(null\)[\s\S]{0,80}return/,
    )
  })
})
