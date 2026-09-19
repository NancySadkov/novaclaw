import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const read = (relative: string) => fs.readFileSync(path.join(import.meta.dir, relative), "utf8")

describe("home-screen visual contracts", () => {
  test("a tile that declares a transparent glyph gets the shared launcher frame", () => {
    // Built-in glyphs and contributed transparent artwork share the same compact frame.
    const tile = read("app-tile.tsx")
    expect(tile).toContain("!!props.app.tileNeedsFrame")
  })

  test("Models uses the shared launcher frame with its own golden glyph", () => {
    // The tile must match the others: a transparent golden glyph that the renderer frames, like the
    // other framed tiles — not the gradient fallback it shipped with first (owner, 2026-09-16).
    const builtins = read("../../apps/builtins.tsx")
    expect(builtins).toMatch(/id: "models",[\s\S]*?tile: "\/assets\/skin\/(?:tiles|glyphs)\/models\.svg"/)
    expect(builtins).toMatch(/id: "models",[\s\S]*?tileNeedsFrame: true/)
    const svg = read("../../../public/assets/skin/tiles/models.svg")
    expect(svg.trimStart().startsWith("<svg")).toBe(true)
  })

  test("every built-in tile URL resolves to a shipped asset", () => {
    const builtins = read("../../apps/builtins.tsx")
    const urls = [...builtins.matchAll(/tile: "(\/assets\/skin\/(?:tiles|glyphs)\/[^"]+)"/g)].map((match) => match[1]!)
    expect(urls.length).toBeGreaterThan(5)
    const missing = urls.filter(
      (url) => !fs.existsSync(path.join(import.meta.dir, "../../../public", url.replace(/^\//, ""))),
    )
    expect(missing, "a built-in tile points at artwork this build does not ship").toEqual([])
  })

  test("the home agent picker uses the themed popup", () => {
    const control = read("../../components/composer/agent-control.tsx")

    expect(control).toContain('from "@novaclaw/ui/v2/select-v2"')
    expect(control).toContain("<SelectV2")
  })

  test("no app surface delegates an open picker to the operating system", () => {
    const sourceRoot = path.join(import.meta.dir, "../..")
    const nativeSelects = [...new Bun.Glob("**/*.tsx").scanSync({ cwd: sourceRoot })].filter((relative) =>
      fs.readFileSync(path.join(sourceRoot, relative), "utf8").includes("<select"),
    )

    expect(nativeSelects).toEqual([])
  })

  test('the home prompt says only "Ask anything..."', () => {
    const english = read("../../i18n/en.ts")

    expect(english).toContain('"home.newAgent.placeholder": "Ask anything..."')
    expect(english).not.toContain("opens ready to configure")
  })
})
