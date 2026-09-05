import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "native-transcript.tsx"), "utf8")

describe("native transcript markdown cache identity", () => {
  test("every markdown renderer receives a stable cache key", () => {
    const renderers = source.match(/<Markdown\b[^>]*\/>/gs) ?? []
    expect(renderers.length).toBeGreaterThan(0)
    expect(renderers.every((renderer) => renderer.includes("cacheKey"))).toBe(true)
  })
})
